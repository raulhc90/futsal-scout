import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';
import {
  supabase, signIn, signOut, onAuthChange,
  fetchGames, upsertGame, deleteGame,
  fetchTeams, upsertTeam, deleteTeam,
} from './supabase';

const PERIOD_TIME = 20 * 60;
const OT_TIME     = 5  * 60;
const POSITIONS   = ['Goleiro','Fixo','Ala Direito','Ala Esquerdo','Pivô','Universal'];
const teamsLSKey  = uid => uid ? `futsal_teams_${uid}` : 'futsal_teams';

const ZONES = [
  {id:'Z1',row:0,col:0},{id:'Z2',row:0,col:1},{id:'Z3',row:0,col:2},
  {id:'Z4',row:1,col:0},{id:'Z5',row:1,col:1},{id:'Z6',row:1,col:2},
  {id:'Z7',row:2,col:0},{id:'Z8',row:2,col:1},{id:'Z9',row:2,col:2},
];
const ZONE_LABELS = {
  Z1:'Def.Esq',Z2:'Def.Ctr',Z3:'Def.Dir',
  Z4:'Meio.Esq',Z5:'Meio.Ctr',Z6:'Meio.Dir',
  Z7:'Atq.Esq',Z8:'Atq.Ctr',Z9:'Atq.Dir',
};
const EVENTS = [
  {id:'fin',  label:'Finalização',color:'#22c55e',emoji:'⚽'},
  {id:'perda',label:'Perda',      color:'#ef4444',emoji:'❌'},
  {id:'recup',label:'Recuperação',color:'#3b82f6',emoji:'🔵'},
  {id:'falta',label:'Falta',      color:'#f59e0b',emoji:'🟡'},
];
const RESULTS = {
  fin:  [{id:'gol',label:'Gol',color:'#22c55e'},{id:'defendida',label:'Defendida',color:'#3b82f6'},{id:'fora',label:'Fora',color:'#6b7280'},{id:'bloqueada',label:'Bloqueada',color:'#f59e0b'}],
  perda:[{id:'pressionada',label:'Pressionada',color:'#ef4444'},{id:'nao_forcada',label:'Não forçada',color:'#f97316'}],
  recup:[{id:'alta',label:'Alta (def)',color:'#22c55e'},{id:'media',label:'Média',color:'#3b82f6'},{id:'baixa',label:'Baixa (atq)',color:'#f59e0b'}],
  falta:[{id:'sofrida',label:'Sofrida',color:'#22c55e'},{id:'cometida',label:'Cometida',color:'#ef4444'}],
};
const NUMERIC_STATES = [
  {id:'normal',label:'5×5',color:'#6b7280'},
  {id:'my_up', label:'5×4',color:'#22c55e'},
  {id:'opp_up',label:'4×5',color:'#ef4444'},
];

const fmtTime = s=>`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
const pct     = (m,a)=>a?Math.round(m/a*100):0;
const getQL   = q=>q===0?'1T':q===1?'2T':`PT${q-1}`;
const BLANK   = ()=>({number:'',name:'',position:'Goleiro'});

const mkTeam = (name,roster)=>({
  name, score:0,
  players:roster.filter(p=>p.number?.toString().trim()&&p.name?.trim()).map((p,i)=>({id:i+1,...p,active:i<5})),
});

const newGame=(nameA,nameB,rA,rB,opts={})=>({
  id:Date.now(),sport:'futsal',myTeam:0,
  teams:[mkTeam(nameA,rA),mkTeam(nameB,rB)],
  gameDate:opts.gameDate||new Date().toLocaleDateString('pt-BR'),
  gameType:opts.gameType||'amistoso',
  competitionName:opts.competitionName||'',
  quarter:0,clock:PERIOD_TIME,numeric:'normal',
  events:[],log:[],finished:false,penalties:null,
});

const GK=uid=>uid?`futsal2_games_${uid}`:'futsal2_games';
function loadGames(uid){try{return JSON.parse(localStorage.getItem(GK(uid)))||[];}catch{return[];}}
function saveGames(g,uid){try{localStorage.setItem(GK(uid),JSON.stringify(g));}catch{}}

function calcMetrics(events){
  const fins=events.filter(e=>e.type==='fin');
  const gols=fins.filter(e=>e.result==='gol');
  const perdas=events.filter(e=>e.type==='perda');
  const recups=events.filter(e=>e.type==='recup');
  const recAlt=recups.filter(e=>e.result==='alta');
  const last8=events.slice(-8);
  const pos8=last8.filter(e=>e.type==='fin'||e.type==='recup').length;
  const neg8=last8.filter(e=>e.type==='perda').length;
  const trend=pos8>neg8+1?'↑':neg8>pos8+1?'↓':'→';
  return{fins:fins.length,gols:gols.length,efi:pct(gols.length,fins.length),perdas:perdas.length,recAlt:recAlt.length,recTotal:recups.length,trend};
}

function dl(content,filename){
  const b=new Blob(['\ufeff'+content],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=filename;a.click();
}
function exportEventsCSV(game){
  const d=game.gameDate||'';
  const matchup=`${game.teams[0].name} vs ${game.teams[1].name}`;
  const lines=['Data,Jogo,Periodo,Tempo,Evento,Zona,Resultado,Jogador,Numerico'];
  game.events.forEach(e=>lines.push(`"${d}","${matchup}","${e.quarter}","${e.time}","${e.type}","${e.zone}","${e.result}","${e.playerName||''}","${e.numeric||'normal'}"`));
  dl(lines.join('\n'),`futsal_eventos_${d.replace(/\//g,'-')}.csv`);
}
function exportZoneCSV(game){
  const d=game.gameDate||'';
  const matchup=`${game.teams[0].name} vs ${game.teams[1].name}`;
  const lines=['Data,Jogo,Zona,Finalizacoes,Gols,EFI%,Perdas,Recuperacoes'];
  ZONES.forEach(z=>{
    const evs=game.events.filter(e=>e.zone===z.id);
    const fins=evs.filter(e=>e.type==='fin');const gols=fins.filter(e=>e.result==='gol');
    const perd=evs.filter(e=>e.type==='perda');const rec=evs.filter(e=>e.type==='recup');
    lines.push(`"${d}","${matchup}","${z.id} (${ZONE_LABELS[z.id]})","${fins.length}","${gols.length}","${pct(gols.length,fins.length)}%","${perd.length}","${rec.length}"`);
  });
  dl(lines.join('\n'),`futsal_zonas_${d.replace(/\//g,'-')}.csv`);
}

// ─── ZoneMap ──────────────────────────────────────────────────────────────────
// Mapa 3x3 clicável com overlay de densidade de eventos
function ZoneMap({events=[], onSelect, activeZone=null, highlightType=null}){
  // Calcular densidade por zona para heatmap visual
  const zoneCounts={};
  ZONES.forEach(z=>{
    const filtered=highlightType?events.filter(e=>e.zone===z.id&&e.type===highlightType):events.filter(e=>e.zone===z.id);
    zoneCounts[z.id]=filtered.length;
  });
  const maxCount=Math.max(...Object.values(zoneCounts),1);

  return(
    <div className="zone-map">
      {/* Labels de orientação */}
      <div className="zone-map-label zone-label-def">DEF</div>
      <div className="zone-grid">
        {ZONES.map(z=>{
          const count=zoneCounts[z.id]||0;
          const intensity=count/maxCount;
          const isActive=activeZone===z.id;
          return(
            <button key={z.id} className={`zone-btn${isActive?' active':''}`}
              style={{'--intensity':intensity,'--zone-color':isActive?'var(--accent)':'transparent'}}
              onClick={()=>onSelect(z.id)}>
              <span className="zone-id">{z.id}</span>
              {count>0&&<span className="zone-count">{count}</span>}
            </button>
          );
        })}
      </div>
      <div className="zone-map-label zone-label-atq">ATQ</div>
    </div>
  );
}

// ─── MetricsBar ───────────────────────────────────────────────────────────────
function MetricsBar({metrics}){
  const{fins,gols,efi,perdas,recAlt,recTotal,trend}=metrics;
  const trendColor=trend==='↑'?'#22c55e':trend==='↓'?'#ef4444':'#6b7280';
  return(
    <div className="metrics-bar">
      <div className="metric-item">
        <span className="metric-val" style={{color:'#22c55e'}}>{fins}</span>
        <span className="metric-label">FIN</span>
        <span className="metric-sub">{gols}⚽</span>
      </div>
      <div className="metric-divider"/>
      <div className="metric-item">
        <span className="metric-val" style={{color:efi>=40?'#22c55e':efi>=25?'#f59e0b':'#ef4444'}}>{efi}%</span>
        <span className="metric-label">EFI</span>
      </div>
      <div className="metric-divider"/>
      <div className="metric-item">
        <span className="metric-val" style={{color:'#ef4444'}}>{perdas}</span>
        <span className="metric-label">PERD</span>
      </div>
      <div className="metric-divider"/>
      <div className="metric-item">
        <span className="metric-val" style={{color:'#3b82f6'}}>{recAlt}</span>
        <span className="metric-label">REC↑</span>
        <span className="metric-sub">{recTotal}tot</span>
      </div>
      <div className="metric-divider"/>
      <div className="metric-item">
        <span className="metric-val" style={{color:trendColor,fontSize:'20px'}}>{trend}</span>
        <span className="metric-label">TEND</span>
      </div>
    </div>
  );
}

// ─── NumericToggle ────────────────────────────────────────────────────────────
function NumericToggle({value, onChange}){
  const idx=NUMERIC_STATES.findIndex(s=>s.id===value);
  const next=()=>onChange(NUMERIC_STATES[(idx+1)%3].id);
  const cur=NUMERIC_STATES[idx];
  return(
    <button className="numeric-toggle" style={{'--nc':cur.color}} onClick={next}>
      {cur.label}
    </button>
  );
}

// ─── ScoreBoard ───────────────────────────────────────────────────────────────
function ScoreBoard({game, running, onToggleRun, onNextPeriod}){
  const numState=NUMERIC_STATES.find(s=>s.id===game.numeric)||NUMERIC_STATES[0];
  const isLow=game.clock<120; // últimos 2 min
  return(
    <div className="scoreboard-bar">
      <div className="sb-team sb-left">
        <span className="sb-name">{game.teams[0].name}</span>
        <span className="sb-score" style={{color:game.myTeam===0?'var(--accent)':'var(--text)'}}>{game.teams[0].score}</span>
      </div>

      <div className="sb-center">
        <div className="sb-period">{getQL(game.quarter)}</div>
        <div className={`sb-clock${isLow?' clock-low':''}`}>{fmtTime(game.clock)}</div>
        <div className="sb-controls">
          <button className={`sb-play${running?' playing':''}`} onClick={onToggleRun}>
            {running?'⏸':'▶'}
          </button>
          <button className="sb-next" onClick={onNextPeriod}>›</button>
        </div>
      </div>

      <div className="sb-team sb-right">
        <span className="sb-score" style={{color:game.myTeam===1?'var(--accent)':'var(--text)'}}>{game.teams[1].score}</span>
        <span className="sb-name">{game.teams[1].name}</span>
      </div>

      <div className="sb-numeric" style={{'--nc':numState.color}}>
        <span>{numState.label}</span>
      </div>
    </div>
  );
}

// ─── PeriodEndModal ───────────────────────────────────────────────────────────
function PeriodEndModal({quarter,scores,onContinue,onOvertime,onPenalties,onFinish}){
  const[s0,s1]=scores;const tied=s0===s1;const isEnd=quarter===1||quarter>=2;
  return(
    <div className="modal-overlay"><div className="modal" style={{maxWidth:'340px'}}>
      <div className="modal-header"><span>Fim do {getQL(quarter)}</span></div>
      <div className="modal-body" style={{textAlign:'center'}}>
        <div style={{fontSize:'36px',fontWeight:800,color:'var(--accent)',margin:'8px 0'}}>{s0} — {s1}</div>
        {tied&&isEnd&&<div style={{fontSize:'13px',color:'var(--muted)'}}>Empate — o que acontece?</div>}
      </div>
      <div className="modal-footer" style={{flexDirection:'column',gap:'8px'}}>
        {!isEnd&&<button className="btn-start" onClick={onContinue}>▶ Iniciar {getQL(quarter+1)}</button>}
        {isEnd&&!tied&&<button className="btn-start" style={{background:'rgba(239,68,68,.15)',color:'var(--red)',border:'1.5px solid var(--red)'}} onClick={onFinish}>🏁 Encerrar</button>}
        {isEnd&&tied&&<>
          <button className="btn-start" onClick={onOvertime}>⏱ Prorrogação</button>
          <button className="btn-start" style={{background:'rgba(239,68,68,.15)',color:'var(--red)',border:'1.5px solid var(--red)'}} onClick={onPenalties}>🥅 Pênaltis</button>
          <button className="btn-start" style={{background:'var(--bg3)',color:'var(--muted)',border:'1px solid var(--border)'}} onClick={onFinish}>Encerrar (empate)</button>
        </>}
      </div>
    </div></div>
  );
}

// ─── PlayerOverlay ────────────────────────────────────────────────────────────
// Aparece após o resultado — seleção opcional rápida de jogador
function PlayerOverlay({players, onSelect, onSkip}){
  const active=players.filter(p=>p.active);
  return(
    <div className="player-overlay">
      <div className="player-overlay-header">
        <span>Quem? <span style={{color:'var(--muted)',fontWeight:400}}>(opcional)</span></span>
        <button className="skip-btn" onClick={onSkip}>Pular →</button>
      </div>
      <div className="player-overlay-grid">
        {active.map((p,i)=>(
          <button key={i} className="pov-btn" onClick={()=>onSelect(p)}>
            <span className="pov-num">#{p.number}</span>
            <span className="pov-name">{p.name.split(' ')[0]}</span>
            <span className="pov-pos">{p.position||''}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── HeatMapPanel ─────────────────────────────────────────────────────────────
function HeatMapPanel({events, teams, myTeam}){
  const [filterType, setFilterType]=useState('fin');
  const myEvents=events;
  return(
    <div className="heatmap-panel">
      <div className="hm-filter-row">
        {EVENTS.map(ev=>(
          <button key={ev.id} className={`hm-filter-btn${filterType===ev.id?' active':''}`}
            style={{'--ec':ev.color}} onClick={()=>setFilterType(ev.id)}>
            {ev.emoji} {ev.label}
          </button>
        ))}
      </div>
      <div className="hm-zone-wrap">
        <ZoneMap events={myEvents} highlightType={filterType} onSelect={()=>{}} activeZone={null}/>
        <div className="hm-legend">
          {RESULTS[filterType]?.map(r=>(
            <div key={r.id} className="hm-legend-item">
              <span className="hm-legend-dot" style={{background:r.color}}/>
              <span>{r.label}: {myEvents.filter(e=>e.type===filterType&&e.result===r.id).length}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="hm-zone-detail">
        {ZONES.map(z=>{
          const evs=myEvents.filter(e=>e.zone===z.id&&e.type===filterType);
          if(!evs.length)return null;
          return(
            <div key={z.id} className="hm-zone-row">
              <span className="hm-zone-id">{z.id}</span>
              <span className="hm-zone-name">{ZONE_LABELS[z.id]}</span>
              <span className="hm-zone-count">{evs.length}</span>
              {filterType==='fin'&&<span className="hm-zone-gols">{evs.filter(e=>e.result==='gol').length}⚽</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── LogPanel ─────────────────────────────────────────────────────────────────
function LogPanel({events, onUndo}){
  return(
    <div className="log-panel">
      <div className="log-top">
        <span>{events.length} eventos</span>
        {events.length>0&&<button className="undo-btn" onClick={onUndo}>↩ Desfazer último</button>}
      </div>
      {events.length===0&&<div className="empty-log">Nenhum evento registrado.</div>}
      <div className="log-list">
        {[...events].reverse().map((e,i)=>{
          const ev=EVENTS.find(ev=>ev.id===e.type);
          const res=RESULTS[e.type]?.find(r=>r.id===e.result);
          return(
            <div key={i} className="log-entry-compact">
              <span className="lec-q">{e.quarter}</span>
              <span className="lec-time">{e.time}</span>
              <span className="lec-ev" style={{color:ev?.color}}>{ev?.emoji} {ev?.label}</span>
              <span className="lec-zone">{e.zone}</span>
              <span className="lec-res" style={{color:res?.color}}>{res?.label}</span>
              {e.playerName&&<span className="lec-player">{e.playerName}</span>}
              {e.numeric&&e.numeric!=='normal'&&<span className="lec-num">{e.numeric==='my_up'?'5×4':'4×5'}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── ScoutPanel — painel principal de registro ────────────────────────────────
// Fluxo: Evento → Zona → Resultado → (Jogador opcional)
function ScoutPanel({game, running, onAddEvent, onAddGoal, onAddGoalAdv}){
  const [step,setStep]   = useState('event');   // event|zone|result|player
  const [pending,setPending] = useState(null);  // {type, zone, result}

  const myTeam=game.teams[game.myTeam];

  const reset=()=>{setStep('event');setPending(null);};

  const onEvent=ev=>{
    setPending({type:ev.id});
    setStep('zone');
  };

  const onZone=zoneId=>{
    setPending(p=>({...p,zone:zoneId}));
    setStep('result');
  };

  const onResult=resId=>{
    setPending(p=>({...p,result:resId}));
    setStep('player');
  };

  const onPlayer=player=>{
    const ev={
      ...pending,
      quarter:getQL(game.quarter),
      time:fmtTime(game.clock),
      numeric:game.numeric,
      playerName:player?`#${player.number} ${player.name.split(' ')[0]}`:'',
      playerIdx:player?myTeam.players.indexOf(player):null,
    };
    // Gol: incrementa placar
    if(ev.type==='fin'&&ev.result==='gol') onAddGoal(ev);
    else onAddEvent(ev);
    reset();
  };

  const results=pending?.type?RESULTS[pending.type]:[];

  return(
    <div className="scout-panel">
      {/* Coluna esquerda — eventos */}
      <div className="scout-col scout-events">
        {EVENTS.map(ev=>(
          <button key={ev.id} className={`event-btn${pending?.type===ev.id?' selected':''}`}
            style={{'--ec':ev.color}}
            disabled={step!=='event'}
            onClick={()=>onEvent(ev)}>
            <span className="ev-emoji">{ev.emoji}</span>
            <span className="ev-label">{ev.label}</span>
          </button>
        ))}
        {/* Gol adversário (placar apenas, sem análise) */}
        <button className="event-btn gol-adv-btn"
          disabled={step!=='event'}
          onClick={()=>onAddGoalAdv()}>
          <span className="ev-emoji">🔴</span>
          <span className="ev-label">Gol Adv</span>
        </button>
      </div>

      {/* Coluna central — zona */}
      <div className="scout-col scout-zone-col">
        <div className="scout-step-label">
          {step==='event'&&'Selecione o evento'}
          {step==='zone'&&`${EVENTS.find(e=>e.id===pending?.type)?.label} — onde?`}
          {step==='result'&&`${EVENTS.find(e=>e.id===pending?.type)?.label} em ${pending?.zone}`}
          {step==='player'&&'Quem? (opcional)'}
        </div>

        {(step==='zone'||step==='result'||step==='player')&&(
          <ZoneMap
            events={game.events}
            onSelect={step==='zone'?onZone:()=>{}}
            activeZone={pending?.zone}
            highlightType={pending?.type}
          />
        )}

        {step==='player'&&(
          <PlayerOverlay
            players={myTeam.players}
            onSelect={player=>onPlayer(player)}
            onSkip={()=>onPlayer(null)}
          />
        )}

        {/* Cancelar */}
        {step!=='event'&&(
          <button className="cancel-flow-btn" onClick={reset}>✕ Cancelar</button>
        )}
      </div>

      {/* Coluna direita — resultado */}
      <div className="scout-col scout-results">
        {step==='result'&&results.map(r=>(
          <button key={r.id} className="result-btn"
            style={{'--rc':r.color}}
            onClick={()=>onResult(r.id)}>
            {r.label}
          </button>
        ))}
        {step==='event'&&(
          <div className="results-placeholder">
            <span>← Resultado</span>
            <span>aparece aqui</span>
          </div>
        )}
        {step==='zone'&&(
          <div className="results-placeholder">
            <span>← Selecione</span>
            <span>a zona</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── NewGameModal ─────────────────────────────────────────────────────────────
function NewGameModal({onStart, onClose, savedTeams=[]}){
  const [nameA,setNameA]=useState('Meu Time');
  const [nameB,setNameB]=useState('Adversário');
  const today=new Date();
  const todayStr=`${String(today.getDate()).padStart(2,'0')}/${String(today.getMonth()+1).padStart(2,'0')}/${today.getFullYear()}`;
  const [gameDate,setGameDate]=useState(todayStr);
  const [gameType,setGameType]=useState('amistoso');
  const [competitionName,setCompetitionName]=useState('');
  const [players,setPlayers]=useState({a:Array.from({length:5},BLANK),b:Array.from({length:5},BLANK)});
  const upd=(t,i,f,v)=>setPlayers(prev=>({...prev,[t]:prev[t].map((p,j)=>j===i?{...p,[f]:v}:p)}));
  const addP=t=>setPlayers(prev=>prev[t].length>=20?prev:({...prev,[t]:[...prev[t],BLANK()]}));
  const removeP=(t,i)=>setPlayers(prev=>({...prev,[t]:prev[t].filter((_,j)=>j!==i)}));
  const loadTeam=(key,team)=>{
    if(key==='a'){setNameA(team.name);setPlayers(p=>({...p,a:team.players.map(pl=>({number:pl.number,name:pl.name,position:pl.position||'Goleiro'}))}))}
    else{setNameB(team.name);setPlayers(p=>({...p,b:team.players.map(pl=>({number:pl.number,name:pl.name,position:pl.position||'Goleiro'}))}))}
  };
  const handleStart=()=>{
    const rA=players.a.filter(p=>p.number.trim()&&p.name.trim());
    const rB=players.b.filter(p=>p.number.trim()&&p.name.trim());
    if(rA.length<5||rB.length<5){alert('Mínimo 5 jogadores por time.');return;}
    onStart(nameA,nameB,rA,rB,{gameDate,gameType,competitionName});
  };
  const btnSt=active=>({flex:1,padding:'10px',borderRadius:'6px',border:'1px solid var(--border)',cursor:'pointer',background:active?'var(--accent)':'var(--bg3)',color:active?'var(--accent-text)':'var(--text)',fontFamily:'var(--fd)',fontWeight:700,fontSize:'13px'});
  return(
    <div className="modal-overlay"><div className="modal">
      <div className="modal-header"><span>Novo Jogo — Futsal</span><button className="modal-close" onClick={onClose}>✕</button></div>
      <div className="modal-body">
        <div className="modal-teams">
          {[['a',nameA,setNameA,'Meu Time (esquerda)'],['b',nameB,setNameB,'Adversário (direita)']].map(([key,name,setName,ph])=>(
            <div key={key} className="modal-team-col">
              {savedTeams.length>0&&(
                <select className="team-select-saved" onChange={e=>{if(e.target.value)loadTeam(key,savedTeams.find(t=>t.id===e.target.value));e.target.value='';}} defaultValue="">
                  <option value="">↓ Time salvo</option>
                  {savedTeams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
              <input className="team-name-input" value={name} onChange={e=>setName(e.target.value)} placeholder={ph}/>
              <div className="modal-roster-header"><span>#</span><span>Nome</span><span>Pos.</span></div>
              <div className="modal-roster">
                {players[key].map((p,i)=>(
                  <div key={i} className="modal-player-row">
                    <input className="num-input" value={p.number} maxLength={2} placeholder="#" onChange={e=>upd(key,i,'number',e.target.value)}/>
                    <input className="name-inp" value={p.name} placeholder="Nome" onChange={e=>upd(key,i,'name',e.target.value)}/>
                    <select style={{background:'var(--bg3)',border:'1px solid var(--border)',color:'var(--text)',borderRadius:'4px',padding:'4px 2px',fontSize:'11px',flex:'0 0 80px'}} value={p.position||'Goleiro'} onChange={e=>upd(key,i,'position',e.target.value)}>
                      {POSITIONS.map(pos=><option key={pos} value={pos}>{pos}</option>)}
                    </select>
                    {players[key].length>1&&<button className="rm-player-btn" onClick={()=>removeP(key,i)}>✕</button>}
                  </div>
                ))}
                {players[key].length<20&&<button className="add-player-btn" onClick={()=>addP(key)}>+ Jogador</button>}
              </div>
            </div>
          ))}
        </div>
        <div style={{marginTop:12}}>
          <div style={{marginBottom:6,fontWeight:'bold',color:'var(--text)'}}>Data e tipo:</div>
          <div style={{display:'flex',gap:'8px',alignItems:'center'}}>
            <input className="login-input" type="text" placeholder="DD/MM/AAAA" value={gameDate} maxLength={10}
              onChange={e=>{let v=e.target.value.replace(/\D/g,'');if(v.length>2)v=v.slice(0,2)+'/'+v.slice(2);if(v.length>5)v=v.slice(0,5)+'/'+v.slice(5,9);setGameDate(v);}} style={{width:'130px',flexShrink:0,margin:0}}/>
            <button type="button" style={btnSt(gameType==='amistoso')} onClick={()=>setGameType('amistoso')}>Amistoso</button>
            <button type="button" style={btnSt(gameType==='competicao')} onClick={()=>setGameType('competicao')}>Competição</button>
          </div>
          {gameType==='competicao'&&<input className="login-input" type="text" placeholder="Nome da competição" value={competitionName} onChange={e=>setCompetitionName(e.target.value)} style={{width:'100%',boxSizing:'border-box',marginTop:'8px'}}/>}
        </div>
      </div>
      <div className="modal-footer"><button className="btn-start" onClick={handleStart}>▶ Iniciar Jogo</button></div>
    </div></div>
  );
}

// ─── TeamsScreen ──────────────────────────────────────────────────────────────
function TeamsScreen({teams,onSave,syncStatus,onClose}){
  const [list,setList]=useState(teams.map(t=>({...t,players:t.players.map(p=>({...p}))})));
  const [editing,setEditing]=useState(null);
  const [newName,setNewName]=useState('');
  const addTeam=()=>{if(!newName.trim())return;const t={id:Date.now().toString(),name:newName.trim(),players:Array.from({length:5},BLANK)};setList(p=>[...p,t]);setNewName('');setEditing(list.length);};
  const removeTeam=(idx)=>{if(!window.confirm('Remover?'))return;setList(p=>p.filter((_,i)=>i!==idx));if(editing===idx)setEditing(null);};
  const updPlayer=(ti,pi,f,v)=>setList(p=>p.map((t,i)=>i!==ti?t:({...t,players:t.players.map((pl,j)=>j!==pi?pl:{...pl,[f]:v})})));
  const addPlayer=(ti)=>setList(p=>p.map((t,i)=>i!==ti?t:t.players.length>=20?t:{...t,players:[...t.players,BLANK()]}));
  const removePlayer=(ti,pi)=>setList(p=>p.map((t,i)=>i!==ti?t:({...t,players:t.players.filter((_,j)=>j!==pi)})));
  const renameTeam=(ti,v)=>setList(p=>p.map((t,i)=>i!==ti?t:{...t,name:v}));
  const ed=editing!==null?list[editing]:null;
  return(
    <div className="modal-overlay"><div className="modal" style={{maxWidth:'520px'}}>
      <div className="modal-header"><span>⚑ Meus Times</span><button className="modal-close" onClick={onClose}>✕</button></div>
      <div className="modal-body" style={{maxHeight:'70vh',overflowY:'auto'}}>
        <div style={{marginBottom:'12px'}}>
          {list.length===0&&<div style={{color:'var(--muted)',textAlign:'center',padding:'16px'}}>Nenhum time cadastrado.</div>}
          {list.map((t,i)=>(
            <div key={t.id} className={`team-list-item${editing===i?' active':''}`}>
              <button className="team-list-name" onClick={()=>setEditing(editing===i?null:i)}>
                <span className="team-list-icon">⚑</span><span>{t.name}</span>
                <span className="team-list-count">{t.players.filter(p=>p.name.trim()).length} jogs</span>
              </button>
              <button className="rm-player-btn" style={{marginLeft:'auto',color:'var(--red)'}} onClick={()=>removeTeam(i)}>✕</button>
            </div>
          ))}
        </div>
        <div style={{display:'flex',gap:'8px',marginBottom:'16px'}}>
          <input className="login-input" placeholder="Nome do novo time" value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addTeam()} style={{flex:1,margin:0}}/>
          <button className="add-player-btn" style={{width:'auto',padding:'8px 16px',margin:0}} onClick={addTeam}>+ Criar</button>
        </div>
        {ed&&(
          <div className="team-editor">
            <input className="team-name-input" value={ed.name} onChange={e=>renameTeam(editing,e.target.value)} style={{marginBottom:'8px',width:'100%',boxSizing:'border-box'}}/>
            <div className="modal-roster-header"><span>#</span><span>Nome</span><span>Posição</span></div>
            <div className="modal-roster">
              {ed.players.map((p,pi)=>(
                <div key={pi} className="modal-player-row">
                  <input className="num-input" value={p.number} maxLength={2} placeholder="#" onChange={e=>updPlayer(editing,pi,'number',e.target.value)}/>
                  <input className="name-inp" value={p.name} placeholder="Nome" onChange={e=>updPlayer(editing,pi,'name',e.target.value)}/>
                  <select style={{background:'var(--bg3)',border:'1px solid var(--border)',color:'var(--text)',borderRadius:'var(--r)',padding:'5px 4px',fontSize:'11px',flex:'0 0 90px'}} value={p.position||'Goleiro'} onChange={e=>updPlayer(editing,pi,'position',e.target.value)}>
                    {POSITIONS.map(pos=><option key={pos} value={pos}>{pos}</option>)}
                  </select>
                  {ed.players.length>1&&<button className="rm-player-btn" onClick={()=>removePlayer(editing,pi)}>✕</button>}
                </div>
              ))}
              {ed.players.length<20&&<button className="add-player-btn" onClick={()=>addPlayer(editing)}>+ Jogador</button>}
            </div>
          </div>
        )}
      </div>
      <div className="modal-footer" style={{flexDirection:'column',gap:'8px'}}>
        {syncStatus==='pending'&&<div className="teams-sync-banner pending">⚠️ Não sincronizado com a nuvem.</div>}
        {syncStatus==='saved'&&<div className="teams-sync-banner saved">✓ Salvo na nuvem.</div>}
        <div style={{display:'flex',gap:'8px',width:'100%'}}>
          <button className="btn-start" style={{flex:1}} onClick={()=>{onSave(list);onClose();}}>Salvar e Fechar</button>
          <button className="btn-start" style={{flex:1,background:'var(--bg3)',color:'var(--text)',border:'1px solid var(--border)'}} onClick={()=>onSave(list)}>↑ Nuvem</button>
        </div>
      </div>
    </div></div>
  );
}

// ─── Login / Reset ────────────────────────────────────────────────────────────
function ResetPasswordScreen(){
  const [pass,setPass]=useState('');const[confirm,setConfirm]=useState('');
  const [error,setError]=useState('');const[success,setSuccess]=useState(false);
  const [loading,setLoading]=useState(false);const[ready,setReady]=useState(false);
  useEffect(()=>{
    const p=new URLSearchParams(window.location.hash.replace('#',''));
    const at=p.get('access_token'),rt=p.get('refresh_token');
    if(at&&rt){supabase.auth.setSession({access_token:at,refresh_token:rt}).then(({error:e})=>{if(e)setError('Link inválido ou expirado.');else{window.history.replaceState(null,'',window.location.pathname);setReady(true);}});}
    else supabase.auth.getSession().then(({data})=>data.session?setReady(true):setError('Link inválido ou expirado.'));
  },[]);
  const handle=async()=>{if(pass.length<6){setError('Mínimo 6 caracteres.');return;}if(pass!==confirm){setError('Senhas não coincidem.');return;}setError('');setLoading(true);const{error:e}=await supabase.auth.updateUser({password:pass});setLoading(false);if(e){setError(e.message);return;}setSuccess(true);setTimeout(async()=>{await supabase.auth.signOut();window.location.href=window.location.origin;},2000);};
  return(<div className="login-screen"><div className="login-box">
    <div className="login-logo"><div style={{fontSize:'36px'}}>⚽</div><div><div className="login-title">WinFast</div><div className="login-subtitle">Futsal Scout</div></div></div>
    <div style={{textAlign:'center',fontFamily:'var(--fd)',fontSize:'16px',fontWeight:700,color:'var(--text)'}}>Redefinir senha</div>
    {success?<div className="teams-sync-banner saved">✓ Senha redefinida!</div>
    :!ready&&!error?<div style={{textAlign:'center',color:'var(--muted)',padding:'12px'}}>⏳ Verificando...</div>
    :<><div className="login-fields">
      <input className="login-input" type="password" placeholder="Nova senha" value={pass} onChange={e=>setPass(e.target.value)} disabled={!ready}/>
      <input className="login-input" type="password" placeholder="Confirmar" value={confirm} onChange={e=>setConfirm(e.target.value)} disabled={!ready}/>
    </div>{error&&<div className="login-error">{error}</div>}
    {ready&&<button className="login-btn" onClick={handle} disabled={loading||!pass||!confirm}>{loading?'Salvando...':'Salvar senha'}</button>}</>}
  </div></div>);
}

function LoginScreen(){
  const [mode,setMode]=useState('login');
  const [email,setEmail]=useState('');const[pass,setPass]=useState('');
  const [error,setError]=useState('');const[info,setInfo]=useState('');
  const [loading,setLoading]=useState(false);
  const Logo=()=>(<div className="login-logo"><div style={{fontSize:'36px'}}>⚽</div><div><div className="login-title">WinFast</div><div className="login-subtitle">Futsal Scout</div></div></div>);
  const handleLogin=async()=>{setError('');setLoading(true);try{const{error:e}=await signIn(email,pass);if(e)throw e;}catch(e){const net=e.message?.toLowerCase().includes('fetch')||e.message?.toLowerCase().includes('network');if(net)setError('⚠️ Sem conexão. Tente pelo hotspot.');else{const m={'Invalid login credentials':'E-mail ou senha incorretos.'};setError(m[e.message]||e.message);}}setLoading(false);};
  const handleForgot=async()=>{if(!email){setError('Digite seu e-mail.');return;}setError('');setLoading(true);const{error:e}=await supabase.auth.resetPasswordForEmail(email,{redirectTo:window.location.origin});setLoading(false);if(e){setError(e.message);return;}setInfo('✓ Link enviado.');};
  if(mode==='forgot')return(<div className="login-screen"><div className="login-box"><Logo/><div className="login-fields"><input className="login-input" type="email" placeholder="Seu e-mail" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleForgot()}/></div>{error&&<div className="login-error">{error}</div>}{info&&<div className="teams-sync-banner saved">{info}</div>}<button className="login-btn" onClick={handleForgot} disabled={loading||!email}>{loading?'Enviando...':'Enviar link'}</button><button onClick={()=>{setMode('login');setError('');setInfo('');}} style={{background:'none',border:'none',color:'var(--muted)',fontSize:'13px',cursor:'pointer',padding:'4px'}}>← Voltar</button></div></div>);
  return(<div className="login-screen"><div className="login-box"><Logo/><div className="login-fields"><input className="login-input" type="email" placeholder="E-mail" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleLogin()}/><input className="login-input" type="password" placeholder="Senha" value={pass} onChange={e=>setPass(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleLogin()}/></div>{error&&<div className="login-error">{error}</div>}<button className="login-btn" onClick={handleLogin} disabled={loading||!email||!pass}>{loading?'Entrando...':'Entrar'}</button><button onClick={()=>{setMode('forgot');setError('');}} style={{background:'none',border:'none',color:'var(--muted)',fontSize:'13px',cursor:'pointer',padding:'4px',textDecoration:'underline'}}>Esqueci minha senha</button></div></div>);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function App(){
  const [screen,setScreen]   = useState('home');
  const [games,setGames]     = useState([]);
  const [game,setGame]       = useState(null);
  const [running,setRunning] = useState(false);
  const [user,setUser]       = useState(null);
  const [authLoading,setAuthLoading] = useState(true);
  const [syncStatus,setSyncStatus]   = useState(''); // eslint-disable-line no-unused-vars
  const [isAdmin,setIsAdmin]         = useState(false); // eslint-disable-line no-unused-vars
  const [savedTeams,setSavedTeams]   = useState([]);
  const [teamsSyncStatus,setTeamsSyncStatus] = useState('');
  const [showNewGame,setShowNewGame] = useState(false);
  const [showTeams,setShowTeams]     = useState(false);
  const [view,setView]   = useState('scout'); // scout|heatmap|log
  const [toast,setToast] = useState(null);
  const [showPeriodEnd,setShowPeriodEnd] = useState(false);
  const syncTimer = useRef(null);

  const showToast = msg=>{setToast(msg);setTimeout(()=>setToast(null),2000);};

  // ── Auth ─────────────────────────────────────────────────────────────────────
  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>{setUser(data.session?.user??null);setAuthLoading(false);});
    const{data:{subscription}}=onAuthChange((_ev,session)=>{
      const u=session?.user??null;setUser(u);setAuthLoading(false);
      if(!u){setSavedTeams([]);setGames([]);setTeamsSyncStatus('');setIsAdmin(false);}
    });
    return()=>subscription.unsubscribe();
  },[]);

  // ── Load on login ─────────────────────────────────────────────────────────────
  useEffect(()=>{
    if(!user)return;
    supabase.from('profiles').select('is_admin').eq('id',user.id).single().then(({data:p})=>setIsAdmin(p?.is_admin||false)).catch(()=>{});
    const lg=loadGames(user.id);if(lg.length>0)setGames(lg);
    fetchGames(user.id).then(cg=>{if(cg.length>0){setGames(cg);saveGames(cg,user.id);}}).catch(()=>{});
    const lt=JSON.parse(localStorage.getItem(teamsLSKey(user.id))||'[]');if(lt.length>0)setSavedTeams(lt);
    fetchTeams(user.id).then(ct=>{if(ct.length>0){setSavedTeams(ct);localStorage.setItem(teamsLSKey(user.id),JSON.stringify(ct));setTeamsSyncStatus('saved');}else if(lt.length>0)setTeamsSyncStatus('pending');}).catch(()=>{if(lt.length>0)setTeamsSyncStatus('pending');});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[user]);

  // ── Auto-save ─────────────────────────────────────────────────────────────────
  useEffect(()=>{
    if(!game)return;
    setGames(prev=>{const idx=prev.findIndex(g=>g.id===game.id);const next=idx>=0?prev.map((g,i)=>i===idx?game:g):[game,...prev];saveGames(next,user?.id);return next;});
    if(user){clearTimeout(syncTimer.current);syncTimer.current=setTimeout(()=>{setSyncStatus('syncing');upsertGame(game,user.id).then(()=>{setSyncStatus('saved');setTimeout(()=>setSyncStatus(''),3000);}).catch(()=>setSyncStatus('error'));},4000);}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[game]);

  const saveTeams=teams=>{
    setSavedTeams(teams);
    if(user)localStorage.setItem(teamsLSKey(user.id),JSON.stringify(teams));
    if(!user){setTeamsSyncStatus('pending');return;}
    setTeamsSyncStatus('syncing');
    Promise.all(teams.map(t=>upsertTeam(t,user.id))).then(()=>fetchTeams(user.id)).then(ct=>{const ids=new Set(teams.map(t=>t.id));ct.filter(t=>!ids.has(t.id)).forEach(t=>deleteTeam(t.id).catch(()=>{}));}).then(()=>{setTeamsSyncStatus('saved');setTimeout(()=>setTeamsSyncStatus(''),4000);}).catch(()=>setTeamsSyncStatus('pending'));
  };

  // ── Cronômetro ────────────────────────────────────────────────────────────────
  useEffect(()=>{
    if(!running||!game)return;
    const id=setInterval(()=>{
      setGame(g=>{if(!g)return g;if(g.clock<=1){setRunning(false);setShowPeriodEnd(true);return{...g,clock:0};}return{...g,clock:g.clock-1};});
    },1000);
    return()=>clearInterval(id);
  },[running,game]);

  // ── startGame ─────────────────────────────────────────────────────────────────
  const startGame=(nameA,nameB,rA,rB,opts)=>{
    const g=newGame(nameA,nameB,rA,rB,opts);
    setGame(g);setShowNewGame(false);setScreen('game');setView('scout');setRunning(true);
  };

  // ── addEvent ──────────────────────────────────────────────────────────────────
  const addEvent=useCallback(ev=>{
    setGame(g=>({...g,events:[...g.events,ev]}));
    showToast(`${EVENTS.find(e=>e.id===ev.type)?.emoji} ${ev.zone} — ${RESULTS[ev.type]?.find(r=>r.id===ev.result)?.label||''}`);
  },[]);

  const addGoal=useCallback(ev=>{
    setGame(g=>{
      const teams=g.teams.map((t,ti)=>ti!==g.myTeam?t:({...t,score:t.score+1}));
      return{...g,teams,events:[...g.events,ev]};
    });
    showToast('⚽ GOL!');
  },[]);

  const addGoalAdv=useCallback(()=>{
    setGame(g=>{
      const advIdx=1-g.myTeam;
      const teams=g.teams.map((t,ti)=>ti!==advIdx?t:({...t,score:t.score+1}));
      return{...g,teams};
    });
    showToast('🔴 Gol adversário');
  },[]);

  const undoLast=useCallback(()=>{
    setGame(g=>{
      if(!g.events.length)return g;
      const events=[...g.events];events.pop();
      return{...g,events};
    });
    showToast('↩ Desfeito');
  },[]);

  const setNumeric=useCallback(val=>{
    setGame(g=>({...g,numeric:val}));
  },[]);

  // ── Auth gates ────────────────────────────────────────────────────────────────
  if(authLoading)return(<div className="app" style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh'}}><div style={{textAlign:'center',color:'var(--muted)',fontFamily:'var(--fd)'}}><div style={{fontSize:'32px'}}>⏳</div>Carregando...</div></div>);
  const hashParams=new URLSearchParams(window.location.hash.replace('#',''));
  if(hashParams.get('type')==='recovery'&&!hashParams.get('error'))return<ResetPasswordScreen/>;
  if(!user)return<LoginScreen/>;

  // ── HOME ──────────────────────────────────────────────────────────────────────
  if(screen==='home')return(
    <div className="app">
      {toast&&<div className="toast">{toast}</div>}
      {showNewGame&&<NewGameModal onStart={startGame} onClose={()=>setShowNewGame(false)} savedTeams={savedTeams}/>}
      {showTeams&&<TeamsScreen teams={savedTeams} onSave={saveTeams} syncStatus={teamsSyncStatus} onClose={()=>setShowTeams(false)}/>}
      <div className="home-screen">
        <div className="home-logo">
          <div style={{fontSize:'48px'}}>⚽</div>
          <div className="home-title">WinFast Futsal Scout</div>
          <div className="home-sub">Análise ao vivo · Regras FIFA</div>
        </div>
        <div className="home-user-bar">
          <div style={{flex:1,minWidth:0}}>
            <span className="home-user-email">{user.email}</span>
            {user.last_sign_in_at&&<div style={{fontSize:'11px',color:'var(--muted)',marginTop:'2px'}}>Último login: {new Date(user.last_sign_in_at).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'})}</div>}
          </div>
          <button className="home-logout-btn" onClick={async()=>{await signOut();setUser(null);setGames([]);setSavedTeams([]);setIsAdmin(false);}}>Sair</button>
        </div>
        <div style={{display:'flex',gap:'10px',width:'100%',maxWidth:'360px'}}>
          <button className="btn-new-game" style={{flex:2}} onClick={()=>setShowNewGame(true)}>+ Novo Jogo</button>
          <button className="btn-teams" onClick={()=>setShowTeams(true)}>
            ⚑ Times
            {teamsSyncStatus==='pending'&&<span className="teams-sync-dot pending">●</span>}
            {teamsSyncStatus==='saved'&&<span className="teams-sync-dot saved">✓</span>}
          </button>
        </div>
        {/* Import JSON */}
        <div style={{display:'flex',gap:'10px',width:'100%',maxWidth:'360px'}}>
          <label className="btn-import" title="Importar jogo JSON">
            ↑ Importar JSON
            <input type="file" accept=".json" style={{display:'none'}} onChange={e=>{
              const file=e.target.files?.[0];if(!file)return;
              const reader=new FileReader();
              reader.onload=ev=>{try{const imported={...JSON.parse(ev.target.result),id:Date.now()};if(!imported.teams||imported.teams.length!==2){showToast('Arquivo inválido');return;}setGames(prev=>{const next=[imported,...prev];saveGames(next,user?.id);return next;});showToast(`Importado: ${imported.teams[0].name} vs ${imported.teams[1].name}`);}catch{showToast('JSON inválido.');}e.target.value='';};
              reader.readAsText(file);
            }}/>
          </label>
        </div>
        {games.length>0&&(
          <div className="recent-games">
            <div className="recent-label">Jogos Salvos</div>
            {games.slice(0,8).map(g=>{
              const m=calcMetrics(g.events||[]);
              return(
                <div key={g.id} className="game-card" style={{position:'relative'}} onClick={()=>{setGame(g);setScreen('game');setView('scout');setRunning(false);}}>
                  <div className="game-card-teams"><span>{g.teams[0].name}</span><span className="game-card-score">{g.teams[0].score} — {g.teams[1].score}</span><span>{g.teams[1].name}</span></div>
                  <div className="game-card-meta">
                    <span>{g.gameDate||g.date}</span>
                    <span style={{color:g.gameType==='competicao'?'var(--accent)':'var(--muted)'}}>{g.gameType==='competicao'?`🏆 ${g.competitionName||'Competição'}`:'Amistoso'}</span>
                    <span style={{color:'#22c55e'}}>{g.events?.length||0} eventos</span>
                    {m.fins>0&&<span style={{color:'#6b7280'}}>{m.efi}% EFI</span>}
                  </div>
                  <div className="export-btns" onClick={e=>e.stopPropagation()}>
                    <button className="export-btn" onClick={()=>exportEventsCSV(g)}>Eventos</button>
                    <button className="export-btn green" onClick={()=>exportZoneCSV(g)}>Zonas</button>
                    <button className="export-btn" style={{color:'var(--blue)',borderColor:'rgba(59,130,246,.3)'}} onClick={()=>{const b=new Blob([JSON.stringify(g,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=`${g.teams[0].name}_vs_${g.teams[1].name}.json`;a.click();}}>JSON</button>
                  </div>
                  <button className="delete-game-btn" onClick={async e=>{e.stopPropagation();if(!window.confirm('Excluir?'))return;await deleteGame(g.id).catch(()=>{});setGames(prev=>{const n=prev.filter(x=>x.id!==g.id);saveGames(n,user?.id);return n;});}}>✕</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  // ── GAME SCREEN ───────────────────────────────────────────────────────────────
  const metrics=calcMetrics(game.events||[]);

  return(
    <div className="app game-app">
      {toast&&<div className="toast">{toast}</div>}

      {showPeriodEnd&&(
        <PeriodEndModal quarter={game.quarter} scores={[game.teams[0].score,game.teams[1].score]}
          onContinue={()=>{setGame(g=>{const nq=g.quarter+1;const nc=nq>=2?OT_TIME:PERIOD_TIME;return{...g,quarter:nq,clock:nc};});setShowPeriodEnd(false);setRunning(true);}}
          onOvertime={()=>{setGame(g=>{const nq=g.quarter+1;return{...g,quarter:nq,clock:OT_TIME};});setShowPeriodEnd(false);setRunning(true);}}
          onPenalties={()=>{setShowPeriodEnd(false);}}
          onFinish={()=>{setGame(g=>({...g,finished:true}));setShowPeriodEnd(false);}}/>
      )}

      {/* ── HEADER ── */}
      <div className="game-header">
        <div className="gh-top">
          <button className="back-btn" onClick={()=>{setRunning(false);setScreen('home');}}>‹</button>
          <ScoreBoard game={game} running={running}
            onToggleRun={()=>setRunning(r=>!r)}
            onNextPeriod={()=>{if(game.clock>0){showToast(`Faltam ${fmtTime(game.clock)}`);return;}setShowPeriodEnd(true);}}/>
          <NumericToggle value={game.numeric} onChange={setNumeric}/>
        </div>
        <MetricsBar metrics={metrics}/>
        <nav className="nav">
          {[['scout','Scout'],['heatmap','Mapa'],['log','Log']].map(([v,l])=>(
            <button key={v} className="nav-btn" data-active={view===v} onClick={()=>setView(v)}>{l}</button>
          ))}
          <button className="nav-btn undo-nav" onClick={undoLast}>↩</button>
        </nav>
      </div>

      {/* ── SCOUT ── */}
      {view==='scout'&&(
        <ScoutPanel
          game={game}
          running={running}
          onAddEvent={addEvent}
          onAddGoal={addGoal}
          onAddGoalAdv={addGoalAdv}/>
      )}

      {/* ── HEATMAP ── */}
      {view==='heatmap'&&<HeatMapPanel events={game.events||[]} teams={game.teams} myTeam={game.myTeam}/>}

      {/* ── LOG ── */}
      {view==='log'&&<LogPanel events={game.events||[]} onUndo={undoLast}/>}

      {/* Game over banner */}
      {game.finished&&(
        <div className="game-over-banner">
          <div className="game-over-title">Jogo Finalizado</div>
          <div className="game-over-score">{game.teams[0].score} — {game.teams[1].score}</div>
          <div style={{display:'flex',gap:'8px',justifyContent:'center',marginTop:'10px'}}>
            <button className="game-over-reset" onClick={()=>exportEventsCSV(game)}>↓ Eventos CSV</button>
            <button className="game-over-reset" onClick={()=>exportZoneCSV(game)}>↓ Zonas CSV</button>
            <button className="game-over-reset" onClick={()=>setGame(g=>({...g,finished:false}))}>Continuar</button>
          </div>
        </div>
      )}
    </div>
  );
}
