import { useState, useEffect, useCallback, useRef } from 'react';
import './App.css';
import {
  supabase, signIn, signOut, onAuthChange,
  fetchGames, upsertGame, deleteGame,
  fetchTeams, upsertTeam, deleteTeam,
  adminListUsers, adminInviteUser, adminResetPassword, adminToggleBan,
} from './supabase';

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const PERIOD_TIME = 20 * 60;  // 20 min
const OT_TIME     = 5  * 60;  // 5 min prorrogação
const FOUL_BONUS  = 6;        // 6ª falta = tiro livre direto
const POSITIONS   = ['Goleiro','Fixo','Ala Direito','Ala Esquerdo','Pivô','Universal'];
const teamsLSKey  = (uid) => uid ? `futsal_teams_${uid}` : 'futsal_teams';

const getQuarterLabel = q => q === 0 ? '1T' : q === 1 ? '2T' : `PT${q - 1}`;
const fmtTime = s => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
const pct = (m, a) => (!a ? '' : `${Math.round(m/a*100)}%`);

const BLANK_PLAYER = () => ({ number: '', name: '', position: 'Goleiro' });

const INITIAL_STATS = () => ({
  goals:0, assists:0, shotsOn:0, shotsOff:0,
  passOk:0, passFail:0, steals:0, losses:0,
  fouls:0, yellowCards:0, redCard:false, saves:0,
  plusMinus:0, timeOnCourt:0, entryTime:null, shots:[],
});

const mkTeam = (name, roster) => ({
  name, score: 0,
  players: roster
    .filter(p => p.number?.toString().trim() && p.name?.trim())
    .map((p, i) => ({ id: i+1, ...p, active: i < 5, ...INITIAL_STATS() })),
});

const newGame = (nameA, nameB, rA, rB, startingTeam=0, gameDate='', gameType='amistoso', competitionName='', homeAttackRight=true) => ({
  id: Date.now(),
  date: new Date().toLocaleDateString('pt-BR'),
  gameDate: gameDate || new Date().toLocaleDateString('pt-BR'),
  gameType, competitionName, sport: 'futsal',
  teams: [mkTeam(nameA, rA), mkTeam(nameB, rB)],
  quarter: 0, clock: PERIOD_TIME,
  log: [], finished: false,
  teamFouls: [[], []],
  homeAttackRight,
  firstPossTeam: startingTeam,
  penalties: null,
});

function loadGames(uid)    { try { return JSON.parse(localStorage.getItem(uid?`futsal_games_${uid}`:'futsal_games'))||[]; } catch { return []; } }
function saveGames(g, uid) { try { localStorage.setItem(uid?`futsal_games_${uid}`:'futsal_games', JSON.stringify(g)); } catch {} }

function dl(content, filename) {
  const b = new Blob(['\ufeff'+content], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = filename; a.click();
}

function exportStatsCSV(game) {
  const d = game.gameDate||game.date||'';
  const tipo = game.gameType==='competicao'?(game.competitionName||'Competição'):'Amistoso';
  const matchup = `${game.teams[0].name} vs ${game.teams[1].name}`;
  const lines = ['Data,Tipo,Jogo,Numero,Nome,Posicao,Time,MIN,GOL,AST,FIN.C,FIN.E,FIN%,PASS.C,PASS.E,PASS%,ROB,PERD,FAL,CA,CV,DEF,+/-'];
  game.teams.forEach(t => t.players.forEach(p => {
    const min = `${Math.floor((p.timeOnCourt||0)/60)}:${String(Math.round((p.timeOnCourt||0)%60)).padStart(2,'0')}`;
    lines.push(`"${d}","${tipo}","${matchup}","${p.number}","${p.name}","${p.position||''}","${t.name}",${min},${p.goals},${p.assists},${p.shotsOn},${p.shotsOff},${pct(p.shotsOn,(p.shotsOn||0)+(p.shotsOff||0))},${p.passOk},${p.passFail},${pct(p.passOk,(p.passOk||0)+(p.passFail||0))},${p.steals},${p.losses},${p.fouls},${p.yellowCards||0},${p.redCard?1:0},${p.saves||0},${p.plusMinus||0}`);
  }));
  dl(lines.join('\n'), `futsal_stats_${d.replace(/\//g,'-')}.csv`);
}

function exportShotsCSV(game) {
  const d = game.gameDate||game.date||'';
  const matchup = `${game.teams[0].name} vs ${game.teams[1].name}`;
  const lines = ['Data,Jogo,Numero,Nome,Time,Periodo,Tempo,X_pct,Y_pct,Certo,Assistencia'];
  game.teams.forEach(t => t.players.forEach(p =>
    (p.shots||[]).forEach(s =>
      lines.push(`"${d}","${matchup}","${p.number}","${p.name}","${t.name}","${s.q||''}","${s.time||''}",${(s.x||0).toFixed(2)},${(s.y||0).toFixed(2)},${s.on?'Sim':'Não'},"${s.assistedBy||''}"`)
    )
  ));
  dl(lines.join('\n'), `futsal_chutes_${d.replace(/\//g,'-')}.csv`);
}

function exportLogCSV(game) {
  const d = game.gameDate||game.date||'';
  const matchup = `${game.teams[0].name} vs ${game.teams[1].name}`;
  const lines = ['Data,Jogo,Periodo,Tempo,Time,Numero,Atleta,Acao,Pontos'];
  game.log.forEach(e => {
    const parts = (e.player||'').match(/^#?(\S+)\s+(.+)$/);
    const num = parts?parts[1]:''; const nm = parts?parts[2]:(e.player||'');
    lines.push(`"${d}","${matchup}","${e.q}","${e.time}","${e.team}","${num}","${nm}","${e.action}",${e.pts||0}`);
  });
  dl(lines.join('\n'), `futsal_log_${d.replace(/\//g,'-')}.csv`);
}

// ─── getAttackDir ──────────────────────────────────────────────────────────────
function getAttackDir(teamIdx, quarter, homeAttackRight=true) {
  const baseRight = teamIdx === 0 ? homeAttackRight : !homeAttackRight;
  const swapped   = quarter >= 1;
  return (baseRight !== swapped) ? 'right' : 'left';
}

// ─── FutsalCourt SVG ──────────────────────────────────────────────────────────
// FIFA 40x20m → 600x300px
// Traves: y=112 a 188 (76px = ~3m)
// Ponto pênalti: 6m = 90px da linha de fundo
// Segunda penalidade: 10m = 150px da linha de fundo
function FutsalCourt({ shots=[], onCourtClick, hasPlayer=false, attackDir='right' }) {
  const W=600, H=300, cy=150, midX=300;
  const goalY1=112, goalY2=188;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="court-svg"
      style={{ cursor: hasPlayer ? 'crosshair' : 'default' }}
      onClick={onCourtClick}>

      {/* Fundo */}
      <rect width={W} height={H} fill="#1a2a1a"/>

      {/* Tint zona de ataque */}
      {attackDir==='right'
        ? <rect x={midX} y={0} width={midX} height={H} fill="rgba(34,197,94,0.05)"/>
        : <rect x={0}    y={0} width={midX} height={H} fill="rgba(34,197,94,0.05)"/>
      }

      {/* Linhas */}
      <g stroke="#4a6a4a" strokeWidth="1.5" fill="none">
        <rect x="2" y="2" width={W-4} height={H-4} rx="2"/>
        <line x1={midX} y1="2" x2={midX} y2={H-2}/>
        <circle cx={midX} cy={cy} r="60"/>
        <circle cx={midX} cy={cy} r="3" fill="#4a6a4a"/>
        {/* Área goleiro esquerda */}
        <path d={`M 2 ${cy-38} Q 92 ${cy-38} 92 ${cy} Q 92 ${cy+38} 2 ${cy+38}`}/>
        {/* Área goleiro direita */}
        <path d={`M ${W-2} ${cy-38} Q ${W-92} ${cy-38} ${W-92} ${cy} Q ${W-92} ${cy+38} ${W-2} ${cy+38}`}/>
        {/* Arco pênalti esquerdo */}
        <path d={`M 90 ${cy-75} A 95 95 0 0 1 90 ${cy+75}`} strokeDasharray="5 3"/>
        {/* Arco pênalti direito */}
        <path d={`M ${W-90} ${cy-75} A 95 95 0 0 0 ${W-90} ${cy+75}`} strokeDasharray="5 3"/>
      </g>

      {/* Traves */}
      <g stroke="#ffffff" strokeWidth="3" strokeLinecap="round">
        <line x1="2" y1={goalY1} x2="2"    y2={goalY2}/>
        <line x1={W-2} y1={goalY1} x2={W-2} y2={goalY2}/>
      </g>
      <rect x="0" y={goalY1} width="4" height={goalY2-goalY1} fill="rgba(255,255,255,0.12)"/>
      <rect x={W-4} y={goalY1} width="4" height={goalY2-goalY1} fill="rgba(255,255,255,0.12)"/>

      {/* Pontos: pênalti (amarelo) e 2ª penalidade (laranja) */}
      <circle cx={90}   cy={cy} r="4.5" fill="#f59e0b"/>
      <circle cx={W-90} cy={cy} r="4.5" fill="#f59e0b"/>
      <circle cx={150}   cy={cy} r="3.5" fill="rgba(249,115,22,0.6)"/>
      <circle cx={W-150} cy={cy} r="3.5" fill="rgba(249,115,22,0.6)"/>

      {/* Seta de ataque */}
      {attackDir==='right' ? (
        <g opacity="0.9">
          <line x1="220" y1={cy} x2="360" y2={cy} stroke="#fae92a" strokeWidth="2.5" strokeDasharray="6 4" strokeLinecap="round"/>
          <polygon points={`360,${cy-10} 378,${cy} 360,${cy+10}`} fill="#fae92a"/>
          <text x="290" y={cy-14} fill="#fae92a" fontSize="9" fontFamily="sans-serif" fontWeight="bold" textAnchor="middle" letterSpacing="2">ATAQUE</text>
        </g>
      ) : (
        <g opacity="0.9">
          <line x1="380" y1={cy} x2="240" y2={cy} stroke="#fae92a" strokeWidth="2.5" strokeDasharray="6 4" strokeLinecap="round"/>
          <polygon points={`240,${cy-10} 222,${cy} 240,${cy+10}`} fill="#fae92a"/>
          <text x="310" y={cy-14} fill="#fae92a" fontSize="9" fontFamily="sans-serif" fontWeight="bold" textAnchor="middle" letterSpacing="2">ATAQUE</text>
        </g>
      )}

      {/* Chutes */}
      {shots.map((s,i) => {
        const px=s.x*W/100, py=s.y*H/100;
        return s.on
          ? <circle key={i} cx={px} cy={py} r="6" fill="#22c55e" stroke="#fff" strokeWidth="0.8" opacity="0.9"/>
          : <g key={i} opacity="0.85">
              <line x1={px-4.5} y1={py-4.5} x2={px+4.5} y2={py+4.5} stroke="#ef4444" strokeWidth="2.2" strokeLinecap="round"/>
              <line x1={px+4.5} y1={py-4.5} x2={px-4.5} y2={py+4.5} stroke="#ef4444" strokeWidth="2.2" strokeLinecap="round"/>
            </g>;
      })}
    </svg>
  );
}

// ─── HeatMap ──────────────────────────────────────────────────────────────────
function HeatMap({ shots, teamName, teamIdx=0, homeAttackRight=true }) {
  const W=600, H=300, cy=150, midX=300, RADIUS=45;
  const clusters = [];
  shots.forEach(s => {
    const sx=s.x*W/100, sy=s.y*H/100;
    const ex = clusters.find(cl => Math.sqrt((cl.cx-sx)**2+(cl.cy-sy)**2) < RADIUS*0.65);
    if (ex) { ex.cx=(ex.cx*ex.n+sx)/(ex.n+1); ex.cy=(ex.cy*ex.n+sy)/(ex.n+1); ex.n++; if(s.on)ex.ok++; }
    else clusters.push({ cx:sx, cy:sy, n:1, ok:s.on?1:0 });
  });
  const maxN = Math.max(...clusters.map(c=>c.n), 1);
  const col  = p => p<0.35?{r:239,g:68,b:68}:p<0.5?{r:249,g:115,b:22}:p<0.65?{r:234,g:179,b:8}:{r:34,g:197,b:94};

  const q12dir = teamIdx===0?(homeAttackRight?'right':'left'):(homeAttackRight?'left':'right');
  const q34dir = q12dir==='right'?'left':'right';

  return (
    <div className="heatmap-wrap">
      <div className="heatmap-title">{teamName} — {shots.length} finalizações</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="court-svg">
        <defs>
          {clusters.map((cl,i)=>{
            const c=col(cl.ok/cl.n), it=cl.n/maxN;
            return(<radialGradient key={i} id={`hg${i}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%"   stopColor={`rgb(${c.r},${c.g},${c.b})`} stopOpacity={0.65*it}/>
              <stop offset="100%" stopColor={`rgb(${c.r},${c.g},${c.b})`} stopOpacity={0}/>
            </radialGradient>);
          })}
        </defs>
        <rect width={W} height={H} fill="#1a2a1a"/>
        <rect x={q12dir==='right'?midX:0} y={0} width={midX} height={H} fill="rgba(250,233,42,0.04)"/>
        <rect x={q34dir==='right'?midX:0} y={0} width={midX} height={H} fill="rgba(59,130,246,0.04)"/>
        <line x1={midX} y1="2" x2={midX} y2={H-2} stroke="rgba(250,233,42,0.35)" strokeWidth="1.5" strokeDasharray="6 4"/>
        <text x={q12dir==='right'?W*0.75:W*0.25} y="13" fill="rgba(250,233,42,0.7)" fontSize="8" fontFamily="sans-serif" fontWeight="bold" textAnchor="middle">1º TEMPO</text>
        <text x={q34dir==='right'?W*0.75:W*0.25} y="13" fill="rgba(59,130,246,0.7)"  fontSize="8" fontFamily="sans-serif" fontWeight="bold" textAnchor="middle">2º TEMPO</text>
        {clusters.map((cl,i)=><circle key={i} cx={cl.cx} cy={cl.cy} r={RADIUS*(0.8+(cl.n/maxN)*0.7)} fill={`url(#hg${i})`}/>)}
        <g stroke="#4a6a4a" strokeWidth="1" fill="none">
          <rect x="2" y="2" width={W-4} height={H-4} rx="2"/>
          <line x1={midX} y1="2" x2={midX} y2={H-2}/>
          <circle cx={midX} cy={cy} r="60"/>
        </g>
        <g stroke="#ffffff" strokeWidth="2.5">
          <line x1="2" y1="112" x2="2"    y2="188"/>
          <line x1={W-2} y1="112" x2={W-2} y2="188"/>
        </g>
        {shots.map((s,i)=>{
          const px=s.x*W/100, py=s.y*H/100;
          return s.on
            ?<circle key={i} cx={px} cy={py} r="4.5" fill="#22c55e" stroke="#fff" strokeWidth="0.5" opacity="0.9"/>
            :<g key={i} opacity="0.8">
              <line x1={px-4} y1={py-4} x2={px+4} y2={py+4} stroke="#ef4444" strokeWidth="1.8" strokeLinecap="round"/>
              <line x1={px+4} y1={py-4} x2={px-4} y2={py+4} stroke="#ef4444" strokeWidth="1.8" strokeLinecap="round"/>
            </g>;
        })}
      </svg>
      <div className="heatmap-legend">
        <span style={{color:'#22c55e'}}>● Gol ({shots.filter(s=>s.on).length})</span>
        <span style={{color:'#ef4444'}}>✕ Fora ({shots.filter(s=>!s.on).length})</span>
        <span style={{color:'#f97316'}}>FIN%: {shots.length>0?Math.round(shots.filter(s=>s.on).length/shots.length*100)+'%':''}</span>
      </div>
    </div>
  );
}
// ─── MODAIS ───────────────────────────────────────────────────────────────────

function ConfirmShotModal({ onGoal, onMiss, onCancel }) {
  return (
    <div className="confirm-overlay"><div className="confirm-modal">
      <div className="confirm-title">Finalização</div>
      <div className="confirm-btns">
        <button className="confirm-btn made" onClick={onGoal}>⚽ Gol</button>
        <button className="confirm-btn missed" onClick={onMiss}>✕ Fora/Defendida</button>
      </div>
      <button className="confirm-cancel" onClick={onCancel}>Cancelar</button>
    </div></div>
  );
}

function AssistModal({ players, scorerIdx, onSelect, onNone, onCancel }) {
  const eligible = players.map((p,i)=>({p,i})).filter(({p,i})=>i!==scorerIdx&&p.active&&!p.redCard);
  return (
    <div className="confirm-overlay"><div className="confirm-modal" style={{maxWidth:'380px',width:'94%'}}>
      <div className="confirm-title">Assistência?</div>
      <button className="assist-none-btn" onClick={onNone}>Sem assistência</button>
      <div className="assist-players-grid" style={{marginTop:'8px'}}>
        {eligible.map(({p,i})=>(
          <button key={i} className="assist-player-btn" onClick={()=>onSelect(i)}>
            <span className="assist-pnum">#{p.number}</span>
            <span className="assist-pname">{p.name.split(' ')[0]}</span>
            <span className="assist-past">{p.assists}ast</span>
          </button>
        ))}
      </div>
      <button className="confirm-cancel" onClick={onCancel}>Cancelar</button>
    </div></div>
  );
}

function CardModal({ player, yellowCount, onYellow, onRed, onCancel }) {
  return (
    <div className="confirm-overlay"><div className="confirm-modal">
      <div className="confirm-title">Cartão — #{player.number} {player.name.split(' ')[0]}</div>
      <div style={{fontSize:'13px',color:'var(--muted)',textAlign:'center',marginBottom:'8px'}}>
        Amarelos: {yellowCount} {yellowCount>=1&&'— próximo = vermelho'}
      </div>
      <div className="confirm-btns" style={{flexDirection:'column',gap:'8px'}}>
        <button className="confirm-btn shot-type" style={{background:'rgba(234,179,8,.12)',borderColor:'#eab308',color:'#eab308'}} onClick={onYellow}>🟡 Amarelo</button>
        <button className="confirm-btn shot-type" style={{background:'rgba(239,68,68,.12)',borderColor:'var(--red)',color:'var(--red)'}} onClick={onRed}>🟥 Vermelho Direto</button>
      </div>
      <button className="confirm-cancel" onClick={onCancel}>Cancelar</button>
    </div></div>
  );
}

function FoulModal({ teamName, foulCount, onConfirm, onCancel }) {
  const willBeBonus = foulCount + 1 >= FOUL_BONUS;
  return (
    <div className="confirm-overlay"><div className="confirm-modal">
      <div className="confirm-title">Falta — {teamName}</div>
      {willBeBonus && <div className="foul-alert danger">⚠️ {foulCount+1}ª falta — TIRO LIVRE DIRETO (10m)!</div>}
      <div style={{fontSize:'13px',color:'var(--muted)',textAlign:'center'}}>Faltas no período: <b>{foulCount}</b></div>
      <div className="confirm-btns">
        <button className="confirm-btn made" onClick={onConfirm}>Confirmar</button>
      </div>
      <button className="confirm-cancel" onClick={onCancel}>Cancelar</button>
    </div></div>
  );
}

function DirectFKModal({ fouledTeam, players, onSelectShooter, onCancel }) {
  const eligible = players.filter(p=>p.active&&!p.redCard);
  return (
    <div className="confirm-overlay"><div className="confirm-modal" style={{maxWidth:'380px',width:'94%'}}>
      <div className="confirm-title">🎯 Tiro Livre Direto (10m)</div>
      <div style={{fontSize:'12px',color:'var(--muted)',textAlign:'center',marginBottom:'8px'}}>{fouledTeam}</div>
      <button className="assist-none-btn" onClick={()=>onSelectShooter(null)}>Não registrar cobrador</button>
      <div className="assist-players-grid" style={{marginTop:'8px'}}>
        {eligible.map((p,i)=>(
          <button key={i} className="assist-player-btn" onClick={()=>onSelectShooter(players.indexOf(p))}>
            <span className="assist-pnum">#{p.number}</span>
            <span className="assist-pname">{p.name.split(' ')[0]}</span>
          </button>
        ))}
      </div>
      <button className="confirm-cancel" onClick={onCancel}>Cancelar</button>
    </div></div>
  );
}

function DirectFKResultModal({ shooter, onGoal, onMiss, onCancel }) {
  return (
    <div className="confirm-overlay"><div className="confirm-modal">
      <div className="confirm-title">🎯 Resultado — TLD</div>
      {shooter&&<div className="ft-player-label">#{shooter.number} {shooter.name.split(' ')[0]}</div>}
      <div className="confirm-btns">
        <button className="confirm-btn made" onClick={onGoal}>⚽ Gol</button>
        <button className="confirm-btn missed" onClick={onMiss}>✕ Não convertido</button>
      </div>
      <button className="confirm-cancel" onClick={onCancel}>Cancelar</button>
    </div></div>
  );
}

function SubModal({ players, outPlayerIdx, onSub, onCancel }) {
  const bench = players.map((p,i)=>({p,i})).filter(({p})=>!p.active&&!p.redCard);
  return (
    <div className="confirm-overlay"><div className="confirm-modal" style={{maxWidth:'380px',width:'94%'}}>
      <div className="confirm-title">↕ Substituição Volante</div>
      {outPlayerIdx!==null&&(
        <div style={{textAlign:'center',fontSize:'13px',color:'var(--muted)',marginBottom:'8px'}}>
          Saindo: <b>#{players[outPlayerIdx]?.number} {players[outPlayerIdx]?.name}</b>
        </div>
      )}
      <div style={{fontSize:'11px',fontWeight:700,color:'var(--muted)',textAlign:'center',padding:'4px 0 6px',letterSpacing:'.08em',textTransform:'uppercase'}}>Quem entra?</div>
      {bench.length===0&&<div style={{textAlign:'center',color:'var(--muted)',padding:'8px'}}>Nenhum atleta no banco disponível</div>}
      <div className="assist-players-grid">
        {bench.map(({p,i})=>(
          <button key={i} className="assist-player-btn" onClick={()=>onSub(i)}>
            <span className="assist-pnum">#{p.number}</span>
            <span className="assist-pname">{p.name.split(' ')[0]}</span>
            <span className="assist-past">{p.position||''}</span>
          </button>
        ))}
      </div>
      <button className="confirm-cancel" onClick={onCancel}>Cancelar</button>
    </div></div>
  );
}

function PeriodEndModal({ quarter, scores, onContinue, onOvertime, onPenalties, onFinish }) {
  const [s0,s1] = scores;
  const tied    = s0===s1;
  const isEnd   = quarter===1||quarter>=2;
  return (
    <div className="modal-overlay"><div className="modal" style={{maxWidth:'360px'}}>
      <div className="modal-header"><span>Fim do {getQuarterLabel(quarter)}</span></div>
      <div className="modal-body" style={{textAlign:'center'}}>
        <div style={{fontSize:'34px',fontWeight:800,color:'var(--accent)',margin:'8px 0'}}>{s0} — {s1}</div>
        {tied&&isEnd&&<div style={{fontSize:'13px',color:'var(--muted)'}}>Empate — o que acontece?</div>}
      </div>
      <div className="modal-footer" style={{flexDirection:'column',gap:'8px'}}>
        {!tied&&isEnd&&<button className="btn-start" style={{background:'rgba(239,68,68,.15)',color:'var(--red)',border:'1.5px solid var(--red)'}} onClick={onFinish}>🏁 Encerrar Jogo</button>}
        {!isEnd&&<button className="btn-start" onClick={onContinue}>▶ Iniciar {getQuarterLabel(quarter+1)}</button>}
        {tied&&isEnd&&<>
          <button className="btn-start" onClick={onOvertime}>⏱ Prorrogação</button>
          <button className="btn-start" style={{background:'rgba(239,68,68,.15)',color:'var(--red)',border:'1.5px solid var(--red)'}} onClick={onPenalties}>🥅 Disputa de Pênaltis</button>
          <button className="btn-start" style={{background:'var(--bg3)',color:'var(--muted)',border:'1px solid var(--border)'}} onClick={onFinish}>Encerrar (empate válido)</button>
        </>}
      </div>
    </div></div>
  );
}

function PenaltyModal({ game, startTeam, onShot, onFinish }) {
  const [kickerIdx, setKickerIdx] = useState(null);
  const shots   = game.penalties?.shots||[];
  const phase   = game.penalties?.phase||'series';
  const t0shots = shots.filter(s=>s.teamIdx===0);
  const t1shots = shots.filter(s=>s.teamIdx===1);
  const t0g     = t0shots.filter(s=>s.scored).length;
  const t1g     = t1shots.filter(s=>s.scored).length;
  const kickTeam= shots.length%2===0?startTeam:1-startTeam;
  const kPlayers= game.teams[kickTeam].players.filter(p=>!p.redCard);

  return (
    <div className="modal-overlay"><div className="modal" style={{maxWidth:'420px'}}>
      <div className="modal-header"><span>🥅 Pênaltis {phase==='sudden'?'— Morte Súbita':''}</span></div>
      <div className="modal-body">
        <div style={{display:'flex',justifyContent:'center',alignItems:'center',gap:'20px',margin:'8px 0 16px'}}>
          {[0,1].map(ti=>(
            <div key={ti} style={{textAlign:'center'}}>
              <div style={{fontSize:'12px',color:'var(--muted)'}}>{game.teams[ti].name}</div>
              <div style={{fontSize:'30px',fontWeight:800,color:'var(--accent)'}}>{ti===0?t0g:t1g}</div>
              <div style={{display:'flex',gap:'3px',justifyContent:'center',marginTop:'4px'}}>
                {(ti===0?t0shots:t1shots).map((s,i)=><span key={i} style={{fontSize:'15px'}}>{s.scored?'⚽':'✕'}</span>)}
              </div>
            </div>
          ))}
        </div>
        <div style={{fontSize:'13px',fontWeight:700,color:'var(--text)',textAlign:'center',marginBottom:'8px'}}>
          Cobrança {shots.length+1} — {game.teams[kickTeam].name}
        </div>
        <div className="assist-players-grid" style={{marginBottom:'12px'}}>
          {kPlayers.map((p,i)=>{
            const realIdx=game.teams[kickTeam].players.indexOf(p);
            return(
              <button key={i} className="assist-player-btn"
                style={kickerIdx===realIdx?{border:'2px solid var(--accent)',background:'rgba(250,233,42,.1)'}:{}}
                onClick={()=>setKickerIdx(realIdx)}>
                <span className="assist-pnum">#{p.number}</span>
                <span className="assist-pname">{p.name.split(' ')[0]}</span>
              </button>
            );
          })}
        </div>
        <div style={{display:'flex',gap:'8px'}}>
          <button className="confirm-btn made" style={{flex:1,padding:'14px'}} onClick={()=>{onShot(kickTeam,kickerIdx,true);setKickerIdx(null);}}>⚽ Gol</button>
          <button className="confirm-btn missed" style={{flex:1,padding:'14px'}} onClick={()=>{onShot(kickTeam,kickerIdx,false);setKickerIdx(null);}}>✕ Fora/Defesa</button>
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn-start" style={{background:'var(--bg3)',color:'var(--muted)',border:'1px solid var(--border)'}} onClick={onFinish}>Encerrar disputa</button>
      </div>
    </div></div>
  );
}

// ─── TeamsScreen ──────────────────────────────────────────────────────────────
function TeamsScreen({ teams, onSave, syncStatus, onClose }) {
  const [list,setList]=useState(teams.map(t=>({...t,players:t.players.map(p=>({...p}))})));
  const [editing,setEditing]=useState(null);
  const [newName,setNewName]=useState('');
  const addTeam=()=>{if(!newName.trim())return;const t={id:Date.now().toString(),name:newName.trim(),players:Array.from({length:5},BLANK_PLAYER)};setList(p=>[...p,t]);setNewName('');setEditing(list.length);};
  const removeTeam=(idx)=>{if(!window.confirm('Remover?'))return;setList(p=>p.filter((_,i)=>i!==idx));if(editing===idx)setEditing(null);};
  const updPlayer=(ti,pi,f,v)=>setList(p=>p.map((t,i)=>i!==ti?t:({...t,players:t.players.map((pl,j)=>j!==pi?pl:{...pl,[f]:v})})));
  const addPlayer=(ti)=>setList(p=>p.map((t,i)=>i!==ti?t:t.players.length>=20?t:{...t,players:[...t.players,BLANK_PLAYER()]}));
  const removePlayer=(ti,pi)=>setList(p=>p.map((t,i)=>i!==ti?t:({...t,players:t.players.filter((_,j)=>j!==pi)})));
  const renameTeam=(ti,v)=>setList(p=>p.map((t,i)=>i!==ti?t:{...t,name:v}));
  const ed=editing!==null?list[editing]:null;
  return(
    <div className="modal-overlay"><div className="modal" style={{maxWidth:'520px'}}>
      <div className="modal-header"><span>⚑ Meus Times (Futsal)</span><button className="modal-close" onClick={onClose}>✕</button></div>
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
                  <select style={{background:'var(--bg3)',border:'1px solid var(--border)',color:'var(--text)',borderRadius:'var(--r)',padding:'5px 4px',fontSize:'11px',flex:'0 0 90px'}}
                    value={p.position||'Goleiro'} onChange={e=>updPlayer(editing,pi,'position',e.target.value)}>
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
        {syncStatus==='syncing'&&<div className="teams-sync-banner syncing">↑ Salvando...</div>}
        {syncStatus==='saved'&&<div className="teams-sync-banner saved">✓ Salvo na nuvem.</div>}
        <div style={{display:'flex',gap:'8px',width:'100%'}}>
          <button className="btn-start" style={{flex:1}} onClick={()=>{onSave(list);onClose();}}>Salvar e Fechar</button>
          <button className="btn-start" style={{flex:1,background:'var(--bg3)',color:'var(--text)',border:'1px solid var(--border)'}} onClick={()=>onSave(list)}>↑ Nuvem</button>
        </div>
      </div>
    </div></div>
  );
}

// ─── NewGameModal ─────────────────────────────────────────────────────────────
function NewGameModal({ onStart, onClose, savedTeams=[] }) {
  const [startingTeam,setStartingTeam]=useState(0);
  const [homeAttackRight,setHomeAttackRight]=useState(true);
  const [nameA,setNameA]=useState('Time A');
  const [nameB,setNameB]=useState('Time B');
  const today=new Date();
  const todayStr=`${String(today.getDate()).padStart(2,'0')}/${String(today.getMonth()+1).padStart(2,'0')}/${today.getFullYear()}`;
  const [gameDate,setGameDate]=useState(todayStr);
  const [gameType,setGameType]=useState('amistoso');
  const [competitionName,setCompetitionName]=useState('');
  const [players,setPlayers]=useState({a:Array.from({length:5},BLANK_PLAYER),b:Array.from({length:5},BLANK_PLAYER)});
  const upd=(t,i,f,v)=>setPlayers(prev=>({...prev,[t]:prev[t].map((p,j)=>j===i?{...p,[f]:v}:p)}));
  const addP=t=>setPlayers(prev=>prev[t].length>=20?prev:({...prev,[t]:[...prev[t],BLANK_PLAYER()]}));
  const removeP=(t,i)=>setPlayers(prev=>({...prev,[t]:prev[t].filter((_,j)=>j!==i)}));
  const loadTeam=(key,team)=>{
    if(key==='a'){setNameA(team.name);setPlayers(p=>({...p,a:team.players.map(pl=>({number:pl.number,name:pl.name,position:pl.position||'Goleiro'}))}))}
    else{setNameB(team.name);setPlayers(p=>({...p,b:team.players.map(pl=>({number:pl.number,name:pl.name,position:pl.position||'Goleiro'}))}))}
  };
  const handleStart=()=>{
    const rA=players.a.filter(p=>p.number.trim()&&p.name.trim());
    const rB=players.b.filter(p=>p.number.trim()&&p.name.trim());
    if(rA.length<5||rB.length<5){alert(`Mínimo 5 jogadores por time.`);return;}
    onStart(nameA,nameB,rA,rB,startingTeam,gameDate,gameType,competitionName,homeAttackRight);
  };
  const btnSt=(active)=>({flex:1,padding:'10px',borderRadius:'6px',border:'1px solid var(--border)',cursor:'pointer',background:active?'var(--accent)':'var(--bg3)',color:active?'var(--accent-text)':'var(--text)',fontFamily:'var(--fd)',fontWeight:700,fontSize:'13px'});
  return(
    <div className="modal-overlay"><div className="modal">
      <div className="modal-header"><span>Novo Jogo — Futsal</span><button className="modal-close" onClick={onClose}>✕</button></div>
      <div className="modal-body">
        <div className="modal-teams">
          {[['a',nameA,setNameA],['b',nameB,setNameB]].map(([key,name,setName])=>(
            <div key={key} className="modal-team-col">
              {savedTeams.length>0&&(
                <select className="team-select-saved" onChange={e=>{if(e.target.value)loadTeam(key,savedTeams.find(t=>t.id===e.target.value));e.target.value='';}} defaultValue="">
                  <option value="">↓ Carregar time salvo</option>
                  {savedTeams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
              <input className="team-name-input" value={name} onChange={e=>setName(e.target.value)} placeholder={key==='a'?'Time da Casa':'Visitante'}/>
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
        <div style={{marginTop:12}}>
          <div style={{marginBottom:6,fontWeight:'bold',color:'var(--text)'}}>Saque inicial:</div>
          <div style={{display:'flex',gap:8}}>
            <button type="button" style={btnSt(startingTeam===0)} onClick={()=>setStartingTeam(0)}>{nameA}</button>
            <button type="button" style={btnSt(startingTeam===1)} onClick={()=>setStartingTeam(1)}>{nameB}</button>
          </div>
        </div>
        <div style={{marginTop:12}}>
          <div style={{marginBottom:6,fontWeight:'bold',color:'var(--text)'}}>Lado de ataque — 1º Tempo:</div>
          <div style={{display:'flex',gap:'8px',alignItems:'center'}}>
            <svg viewBox="0 0 120 60" width="120" height="60" style={{borderRadius:'6px',border:'1px solid var(--border)'}}>
              <rect width="120" height="60" fill="#1a2a1a"/>
              <line x1="60" y1="2" x2="60" y2="58" stroke="var(--border)" strokeWidth="1" strokeDasharray="3 2"/>
              <rect x="2" y="22" width="6" height="16" fill="none" stroke="#5a7a5a" strokeWidth="1.2"/>
              <rect x="112" y="22" width="6" height="16" fill="none" stroke="#5a7a5a" strokeWidth="1.2"/>
              {homeAttackRight?<>
                <line x1="35" y1="30" x2="72" y2="30" stroke="#fae92a" strokeWidth="2" strokeDasharray="4 3" strokeLinecap="round"/>
                <polygon points="72,25 82,30 72,35" fill="#fae92a"/>
                <text x="20" y="12" fill="#fae92a" fontSize="7" fontFamily="sans-serif" fontWeight="bold">{nameA}</text>
              </>:<>
                <line x1="85" y1="30" x2="48" y2="30" stroke="#fae92a" strokeWidth="2" strokeDasharray="4 3" strokeLinecap="round"/>
                <polygon points="48,25 38,30 48,35" fill="#fae92a"/>
                <text x="65" y="12" fill="#fae92a" fontSize="7" fontFamily="sans-serif" fontWeight="bold">{nameA}</text>
              </>}
            </svg>
            <button type="button" className="attack-dir-btn" onClick={()=>setHomeAttackRight(v=>!v)}>⇄ Inverter</button>
          </div>
          <div style={{marginTop:6,fontSize:'12px',color:'var(--muted)'}}>{homeAttackRight?`${nameA} ataca à DIREITA no 1T`:`${nameA} ataca à ESQUERDA no 1T`}</div>
        </div>
      </div>
      <div className="modal-footer"><button className="btn-start" onClick={handleStart}>▶ Iniciar Jogo</button></div>
    </div></div>
  );
}

// ─── LoginScreen / ResetPasswordScreen ───────────────────────────────────────
function ResetPasswordScreen() {
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
  const Logo=()=>(<div className="login-logo"><svg viewBox="0 0 60 60" width="52" height="52"><circle cx="30" cy="30" r="28" fill="#22c55e" stroke="#16a34a" strokeWidth="1"/><text x="30" y="38" fill="white" fontSize="26" textAnchor="middle" fontWeight="bold">⚽</text></svg><div><div className="login-title">WinFast</div><div className="login-subtitle">Futsal Scout</div></div></div>);
  return(<div className="login-screen"><div className="login-box"><Logo/><div style={{textAlign:'center',fontFamily:'var(--fd)',fontSize:'18px',fontWeight:700,color:'var(--text)'}}>Redefinir senha</div>
    {success?<div className="teams-sync-banner saved">✓ Senha redefinida! Redirecionando...</div>
    :!ready&&!error?<div style={{textAlign:'center',color:'var(--muted)',padding:'12px'}}><div style={{fontSize:'22px'}}>⏳</div>Verificando link...</div>
    :<><div className="login-fields">
      <input className="login-input" type="password" placeholder="Nova senha" value={pass} onChange={e=>setPass(e.target.value)} disabled={!ready}/>
      <input className="login-input" type="password" placeholder="Confirmar" value={confirm} onChange={e=>setConfirm(e.target.value)} disabled={!ready}/>
    </div>{error&&<div className="login-error">{error}</div>}
    {ready&&<button className="login-btn" onClick={handle} disabled={loading||!pass||!confirm}>{loading?'Salvando...':'Salvar nova senha'}</button>}</>}
  </div></div>);
}

function LoginScreen() {
  const [mode,setMode]=useState('login');
  const [email,setEmail]=useState('');const[pass,setPass]=useState('');
  const [error,setError]=useState('');const[info,setInfo]=useState('');
  const [loading,setLoading]=useState(false);
  const Logo=()=>(<div className="login-logo"><svg viewBox="0 0 60 60" width="52" height="52"><circle cx="30" cy="30" r="28" fill="#22c55e" stroke="#16a34a" strokeWidth="1"/><text x="30" y="38" fill="white" fontSize="26" textAnchor="middle" fontWeight="bold">⚽</text></svg><div><div className="login-title">WinFast</div><div className="login-subtitle">Futsal Scout</div></div></div>);
  const handleLogin=async()=>{setError('');setInfo('');setLoading(true);try{const{error:e}=await signIn(email,pass);if(e)throw e;}catch(e){const net=e.message?.toLowerCase().includes('fetch')||e.message?.toLowerCase().includes('network')||e.message?.toLowerCase().includes('failed');if(net)setError('⚠️ Sem conexão. Tente pelo hotspot.');else{const m={'Invalid login credentials':'E-mail ou senha incorretos.','Email not confirmed':'Confirme seu e-mail.'};setError(m[e.message]||e.message);}}setLoading(false);};
  const handleForgot=async()=>{if(!email){setError('Digite seu e-mail.');return;}setError('');setInfo('');setLoading(true);const{error:e}=await supabase.auth.resetPasswordForEmail(email,{redirectTo:window.location.origin});setLoading(false);if(e){setError(e.message);return;}setInfo('✓ Link enviado. Verifique seu e-mail.');};
  if(mode==='forgot')return(<div className="login-screen"><div className="login-box"><Logo/><div style={{textAlign:'center',fontFamily:'var(--fd)',fontSize:'16px',fontWeight:700,color:'var(--text)'}}>Esqueci minha senha</div><div className="login-fields"><input className="login-input" type="email" placeholder="Seu e-mail" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleForgot()}/></div>{error&&<div className="login-error">{error}</div>}{info&&<div className="teams-sync-banner saved">{info}</div>}<button className="login-btn" onClick={handleForgot} disabled={loading||!email}>{loading?'Enviando...':'Enviar link'}</button><button onClick={()=>{setMode('login');setError('');setInfo('');}} style={{background:'none',border:'none',color:'var(--muted)',fontSize:'13px',cursor:'pointer',padding:'4px'}}>← Voltar</button></div></div>);
  return(<div className="login-screen"><div className="login-box"><Logo/><div className="login-fields"><input className="login-input" type="email" placeholder="E-mail" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleLogin()}/><input className="login-input" type="password" placeholder="Senha" value={pass} onChange={e=>setPass(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleLogin()}/></div>{error&&<div className="login-error">{error}</div>}<button className="login-btn" onClick={handleLogin} disabled={loading||!email||!pass}>{loading?'Entrando...':'Entrar'}</button><button onClick={()=>{setMode('forgot');setError('');}} style={{background:'none',border:'none',color:'var(--muted)',fontSize:'13px',cursor:'pointer',padding:'4px',textDecoration:'underline'}}>Esqueci minha senha</button></div></div>);
}

// ─── AdminScreen ──────────────────────────────────────────────────────────────
function AdminScreen({ onClose }) {
  const [users,setUsers]=useState([]);const[loading,setLoading]=useState(true);
  const [inviteEmail,setInviteEmail]=useState('');
  const [actionMsg,setActionMsg]=useState('');const[actionErr,setActionErr]=useState('');
  const msg=(m,err=false)=>{if(err){setActionErr(m);setTimeout(()=>setActionErr(''),4000);}else{setActionMsg(m);setTimeout(()=>setActionMsg(''),4000);}};
  const load=()=>{setLoading(true);adminListUsers().then(r=>{setUsers(r.users);setLoading(false);}).catch(e=>{msg(e.message,true);setLoading(false);});};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{load();},[]);
  const handleInvite=async()=>{if(!inviteEmail.trim())return;try{await adminInviteUser(inviteEmail.trim());msg(`Convite enviado para ${inviteEmail}`);setInviteEmail('');load();}catch(e){msg(e.message,true);}};
  const handleReset=async(email)=>{try{await adminResetPassword(email);msg(`Reset enviado para ${email}`);}catch(e){msg(e.message,true);}};
  const handleBan=async(u)=>{if(!window.confirm(`${u.banned?'Desbloquear':'Bloquear'} ${u.email}?`))return;try{await adminToggleBan(u.id,!u.banned);msg(`Usuário ${u.banned?'desbloqueado':'bloqueado'}`);load();}catch(e){msg(e.message,true);}};
  const fmtDate=d=>d?new Date(d).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
  return(
    <div className="modal-overlay"><div className="modal" style={{maxWidth:'680px'}}>
      <div className="modal-header"><span>⚙ Administração</span><button className="modal-close" onClick={onClose}>✕</button></div>
      <div className="modal-body" style={{maxHeight:'75vh',overflowY:'auto'}}>
        {actionMsg&&<div className="teams-sync-banner saved" style={{marginBottom:'10px'}}>{actionMsg}</div>}
        {actionErr&&<div className="teams-sync-banner error" style={{marginBottom:'10px'}}>{actionErr}</div>}
        <div style={{marginBottom:'16px'}}>
          <div style={{fontWeight:700,color:'var(--text)',marginBottom:'8px',fontSize:'13px',textTransform:'uppercase',letterSpacing:'.05em'}}>Convidar usuário</div>
          <div style={{display:'flex',gap:'8px'}}>
            <input className="login-input" type="email" placeholder="email@exemplo.com" value={inviteEmail} onChange={e=>setInviteEmail(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleInvite()} style={{flex:1,margin:0}}/>
            <button className="add-player-btn" style={{width:'auto',padding:'8px 18px',margin:0}} onClick={handleInvite}>✉ Convidar</button>
          </div>
        </div>
        <div style={{fontWeight:700,color:'var(--text)',marginBottom:'8px',fontSize:'13px',textTransform:'uppercase',letterSpacing:'.05em'}}>Usuários {!loading&&`(${users.length})`}</div>
        {loading&&<div style={{color:'var(--muted)',textAlign:'center',padding:'20px'}}>Carregando...</div>}
        {!loading&&users.map(u=>(
          <div key={u.id} className="admin-user-row" style={{opacity:u.banned?.5:1,borderColor:u.is_admin?'var(--accent)':u.banned?'var(--red)':'var(--border)'}}>
            <div className="admin-user-info">
              <div className="admin-user-email">
                {u.is_admin&&<span className="admin-badge">ADM</span>}
                {u.banned&&<span className="admin-badge banned">BLOQ</span>}
                {!u.email_confirmed_at&&<span className="admin-badge pending">PEND</span>}
                {u.email}
              </div>
              <div className="admin-user-meta">
                📅 {fmtDate(u.created_at)} · 🕐 {fmtDate(u.last_sign_in_at)}
              </div>
            </div>
            <div className="admin-user-actions">
              <button className="admin-action-btn reset" onClick={()=>handleReset(u.email)}>↺ Reset</button>
              {!u.is_admin&&<button className={`admin-action-btn ${u.banned?'unban':'ban'}`} onClick={()=>handleBan(u)}>{u.banned?'✓ Desbloq':'⊘ Bloq'}</button>}
            </div>
          </div>
        ))}
      </div>
      <div className="modal-footer"><button className="btn-start" style={{background:'var(--bg3)',color:'var(--text)',border:'1px solid var(--border)'}} onClick={onClose}>Fechar</button></div>
    </div></div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [screen,setScreen]   = useState('home');
  const [games,setGames]     = useState([]);
  const [game,setGame]       = useState(null);
  const [running,setRunning] = useState(false);
  const [user,setUser]       = useState(null);
  const [authLoading,setAuthLoading] = useState(true);
  const [syncStatus,setSyncStatus]   = useState('');
  const [isAdmin,setIsAdmin]         = useState(false);
  const [showAdmin,setShowAdmin]     = useState(false);
  const [savedTeams,setSavedTeams]   = useState([]);
  const [teamsSyncStatus,setTeamsSyncStatus] = useState('');
  const [showNewGame,setShowNewGame] = useState(false);
  const [showTeams,setShowTeams]     = useState(false);
  const [view,setView]       = useState('scout');
  const [toast,setToast]     = useState(null);
  const [activeTeam,setActiveTeam]         = useState(0);
  const [selectedPlayerA,setSelectedPlayerA] = useState(null);
  const [selectedPlayerB,setSelectedPlayerB] = useState(null);
  const [showPeriodEnd,setShowPeriodEnd] = useState(false);
  const [showPenalty,setShowPenalty]     = useState(false);
  const [confirmShot,setConfirmShot]     = useState(null);
  const [assistPending,setAssistPending] = useState(null);
  const [cardPending,setCardPending]     = useState(false);
  const [foulPending,setFoulPending]     = useState(false);
  const [directFKPending,setDirectFKPending] = useState(null);
  const [directFKShooter,setDirectFKShooter] = useState(null);
  const [subModal,setSubModal]           = useState(null);
  const undoStack = useRef([]);
  const syncTimer = useRef(null);

  const showToast = msg => { setToast(msg); setTimeout(()=>setToast(null),2200); };
  const selectedPlayer = activeTeam===0 ? selectedPlayerA : selectedPlayerB;

  // ── Auth ─────────────────────────────────────────────────────────────────────
  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>{ setUser(data.session?.user??null); setAuthLoading(false); });
    const {data:{subscription}}=onAuthChange((_ev,session)=>{
      const u=session?.user??null; setUser(u); setAuthLoading(false);
      if(!u){setSavedTeams([]);setGames([]);setTeamsSyncStatus('');setIsAdmin(false);}
    });
    return()=>subscription.unsubscribe();
  },[]);

  // ── Load data on login ────────────────────────────────────────────────────────
  useEffect(()=>{
    if(!user)return;
    supabase.from('profiles').select('is_admin').eq('id',user.id).single().then(({data:p})=>setIsAdmin(p?.is_admin||false)).catch(()=>{});
    const lg=loadGames(user.id); if(lg.length>0)setGames(lg);
    fetchGames(user.id).then(cg=>{if(cg.length>0){setGames(cg);saveGames(cg,user.id);}}).catch(()=>{});
    const lt=JSON.parse(localStorage.getItem(teamsLSKey(user.id))||'[]'); if(lt.length>0)setSavedTeams(lt);
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

  const saveTeams=(teams)=>{
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

  // ── Minutagem em quadra ───────────────────────────────────────────────────────
  useEffect(()=>{
    if(!game)return;
    if(!running){
      setGame(g=>{if(!g)return g;const now=g.clock;const teams=g.teams.map(t=>({...t,players:t.players.map(p=>{if(!p.active||p.entryTime===null)return p;return{...p,timeOnCourt:(p.timeOnCourt||0)+Math.max(p.entryTime-now,0),entryTime:now};})}));return{...g,teams};});
    } else {
      setGame(g=>{if(!g)return g;const teams=g.teams.map(t=>({...t,players:t.players.map(p=>({...p,entryTime:p.active&&p.entryTime===null?g.clock:p.entryTime}))}));return{...g,teams};});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[running]);

  // ── setGameWithUndo ───────────────────────────────────────────────────────────
  const setGameWithUndo=useCallback((updater)=>{
    setGame(prev=>{if(prev)undoStack.current=[prev,...undoStack.current].slice(0,8);return typeof updater==='function'?updater(prev):updater;});
  },[]);

  const undoLastAction=useCallback(()=>{
    if(!undoStack.current.length){showToast('Nada para desfazer');return;}
    const prev=undoStack.current[0]; setGame(prev); undoStack.current=undoStack.current.slice(1); showToast('Ação desfeita');
  },[]);

  // ── startGame ─────────────────────────────────────────────────────────────────
  const startGame=(nameA,nameB,rA,rB,startingTeam,gameDate,gameType,competitionName,homeAttackRight)=>{
    const g=newGame(nameA,nameB,rA,rB,startingTeam,gameDate,gameType,competitionName,homeAttackRight);
    setGame(g);setShowNewGame(false);setScreen('game');setView('scout');
    setActiveTeam(startingTeam);setSelectedPlayerA(null);setSelectedPlayerB(null);setRunning(true);
  };

  // ── Ações de jogo ─────────────────────────────────────────────────────────────
  const commitGoal=useCallback((scorerIdx,xPct,yPct,assistIdx)=>{
    setGameWithUndo(g=>{
      const teams=g.teams.map((t,ti)=>{
        const players=t.players.map((p,pi)=>{
          const n={...p};
          if(ti===activeTeam){
            if(pi===scorerIdx){n.goals++;n.shotsOn++;n.shots=[...(n.shots||[]),{x:xPct,y:yPct,on:true,q:getQuarterLabel(g.quarter),time:fmtTime(g.clock),assistedBy:assistIdx!==null?`#${g.teams[activeTeam].players[assistIdx].number} ${g.teams[activeTeam].players[assistIdx].name.split(' ')[0]}`:''  }];}
            if(pi===assistIdx)n.assists++;
            if(p.active)n.plusMinus=(n.plusMinus||0)+1;
          }else{if(p.active)n.plusMinus=(n.plusMinus||0)-1;}
          return n;
        });
        return{...t,score:ti===activeTeam?t.score+1:t.score,players};
      });
      const sp=g.teams[activeTeam].players[scorerIdx];
      const ap=assistIdx!==null?g.teams[activeTeam].players[assistIdx]:null;
      const entries=[];
      if(ap)entries.push({id:Date.now(),q:getQuarterLabel(g.quarter),time:fmtTime(g.clock),team:g.teams[activeTeam].name,player:`#${ap.number} ${ap.name.split(' ')[0]}`,action:'Assistência',pts:0,color:'#a855f7'});
      entries.push({id:Date.now()+1,q:getQuarterLabel(g.quarter),time:fmtTime(g.clock),team:g.teams[activeTeam].name,player:`#${sp.number} ${sp.name.split(' ')[0]}`,action:'⚽ GOL',pts:1,color:'#22c55e'});
      return{...g,teams,log:[...entries,...g.log]};
    });
    showToast('⚽ GOL!');setActiveTeam(t=>1-t);setSelectedPlayerA(null);setSelectedPlayerB(null);setAssistPending(null);
  },[activeTeam,setGameWithUndo]);

  const commitShot=useCallback((pIdx,xPct,yPct)=>{
    setGameWithUndo(g=>{
      const teams=g.teams.map((t,ti)=>ti!==activeTeam?t:({...t,players:t.players.map((p,pi)=>pi!==pIdx?p:({...p,shotsOff:(p.shotsOff||0)+1,shots:[...(p.shots||[]),{x:xPct,y:yPct,on:false,q:getQuarterLabel(g.quarter),time:fmtTime(g.clock)}]}))}));
      const sp=g.teams[activeTeam].players[pIdx];
      const entry={id:Date.now(),q:getQuarterLabel(g.quarter),time:fmtTime(g.clock),team:g.teams[activeTeam].name,player:`#${sp.number} ${sp.name.split(' ')[0]}`,action:'Finalização (fora)',pts:0,color:'#ef4444'};
      return{...g,teams,log:[entry,...g.log]};
    });
    showToast('Finalização — fora/defendida');
  },[activeTeam,setGameWithUndo]);

  const commitFoul=useCallback((teamIdx)=>{
    const q=game?.quarter||0;
    const tf=(game?.teamFouls?.[teamIdx]||[]);
    while(tf.length<=q)tf.push(0);
    const newCount=(tf[q]||0)+1;
    const isBonus=newCount>=FOUL_BONUS;
    setGameWithUndo(g=>{
      const teamFouls=g.teamFouls.map((t2,i)=>{if(i!==teamIdx)return t2;const arr=[...t2];while(arr.length<=q)arr.push(0);arr[q]=(arr[q]||0)+1;return arr;});
      const pl=selectedPlayer!==null?g.teams[teamIdx].players[selectedPlayer]:null;
      const playerLabel=pl?`#${pl.number} ${pl.name.split(' ')[0]}`:g.teams[teamIdx].name;
      const entry={id:Date.now(),q:getQuarterLabel(g.quarter),time:fmtTime(g.clock),team:g.teams[teamIdx].name,player:playerLabel,action:`Falta (${newCount}ª no período)`,pts:0,color:'#f97316'};
      const teams=pl?g.teams.map((t,ti)=>ti!==teamIdx?t:({...t,players:t.players.map((p,pi)=>pi!==selectedPlayer?p:({...p,fouls:(p.fouls||0)+1}))})):g.teams;
      return{...g,teamFouls,teams,log:[entry,...g.log]};
    });
    setFoulPending(false);
    if(isBonus){showToast(`⚠️ ${newCount}ª falta — Tiro Livre Direto!`);setDirectFKPending({fouledTeamIdx:1-teamIdx});}
    else showToast(`Falta ${newCount}ª`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[game,selectedPlayer,setGameWithUndo]);

  const commitCard=useCallback((isRed)=>{
    if(selectedPlayer===null)return;
    const pl=game?.teams[activeTeam].players[selectedPlayer];
    if(!pl)return;
    const newYellow=(pl.yellowCards||0)+(isRed?0:1);
    const expelled=isRed||(newYellow>=2);
    setGameWithUndo(g=>{
      const teams=g.teams.map((t,ti)=>ti!==activeTeam?t:({...t,players:t.players.map((p,pi)=>{if(pi!==selectedPlayer)return p;return{...p,yellowCards:newYellow,redCard:expelled,active:expelled?false:p.active};})}));
      const action=isRed?'🟥 Cartão Vermelho':expelled?'🟥 2º Amarelo (Expulso)':'🟡 Cartão Amarelo';
      const entry={id:Date.now(),q:getQuarterLabel(g.quarter),time:fmtTime(g.clock),team:g.teams[activeTeam].name,player:`#${pl.number} ${pl.name.split(' ')[0]}`,action,pts:0,color:expelled?'#ef4444':'#eab308'};
      return{...g,teams,log:[entry,...g.log]};
    });
    setCardPending(false);
    showToast(expelled?`🟥 ${pl.name.split(' ')[0]} EXPULSO`:`🟡 Amarelo — ${pl.name.split(' ')[0]}`);
    if(expelled){setSelectedPlayerA(null);setSelectedPlayerB(null);}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[selectedPlayer,activeTeam,game,setGameWithUndo]);

  const applyAction=useCallback((actionId,teamIdx)=>{
    const pIdx=teamIdx===0?selectedPlayerA:selectedPlayerB;
    if(pIdx===null){showToast('Selecione um atleta');return;}
    const labels={passOk:'Passe ✓',passFail:'Passe ✕',steals:'Roubo de bola',losses:'Perda de bola',saves:'Defesa (goleiro)'};
    const colors={passOk:'#22c55e',passFail:'#ef4444',steals:'#10b981',losses:'#f97316',saves:'#3b82f6'};
    setGameWithUndo(g=>{
      const teams=g.teams.map((t,ti)=>ti!==teamIdx?t:({...t,players:t.players.map((p,pi)=>pi!==pIdx?p:({...p,[actionId]:(p[actionId]||0)+1}))}));
      const pl=g.teams[teamIdx].players[pIdx];
      const entry={id:Date.now(),q:getQuarterLabel(g.quarter),time:fmtTime(g.clock),team:g.teams[teamIdx].name,player:`#${pl.number} ${pl.name.split(' ')[0]}`,action:labels[actionId]||actionId,pts:0,color:colors[actionId]||'#64748b'};
      return{...g,teams,log:[entry,...g.log]};
    });
    showToast(`${labels[actionId]} — #${game?.teams[teamIdx].players[pIdx].number}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[selectedPlayerA,selectedPlayerB,setGameWithUndo,game]);

  const executeSub=useCallback((inIdx)=>{
    if(!game||!subModal)return;
    const outIdx=subModal.outIdx;
    setGame(g=>({...g,teams:g.teams.map((t,ti)=>{if(ti!==activeTeam)return t;return{...t,players:t.players.map((p,pi)=>{if(pi===outIdx){const el=running&&p.entryTime!==null?p.entryTime-g.clock:0;return{...p,active:false,entryTime:null,timeOnCourt:(p.timeOnCourt||0)+Math.max(el,0)};}if(pi===inIdx)return{...p,active:true,entryTime:running?g.clock:null};return p;})};} )}));
    const out=game.teams[activeTeam].players[outIdx];
    const inn=game.teams[activeTeam].players[inIdx];
    setGame(g=>{const entry={id:Date.now(),q:getQuarterLabel(g.quarter),time:fmtTime(g.clock),team:g.teams[activeTeam].name,player:`#${out.number} ${out.name.split(' ')[0]}`,action:`↕ Saiu → #${inn.number} ${inn.name.split(' ')[0]}`,pts:0,color:'#64748b'};return{...g,log:[entry,...g.log]};});
    showToast(`↕ ${out.name.split(' ')[0]} → ${inn.name.split(' ')[0]}`);
    setSubModal(null);setSelectedPlayerA(null);setSelectedPlayerB(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[game,subModal,activeTeam,running]);

  const handleCourtClick=useCallback(e=>{
    if(selectedPlayer===null||confirmShot||assistPending||foulPending||cardPending||directFKPending||subModal)return;
    if(game?.finished){showToast('Jogo finalizado');return;}
    if(!running){showToast('Inicie o cronômetro');return;}
    const rect=e.currentTarget.getBoundingClientRect();
    const xPct=(e.clientX-rect.left)/rect.width*100;
    const yPct=(e.clientY-rect.top)/rect.height*100;
    setConfirmShot({xPct,yPct});
  },[selectedPlayer,confirmShot,assistPending,foulPending,cardPending,directFKPending,subModal,running,game]);

  const handlePenaltyShot=useCallback((kickTeamIdx,kickerPlayerIdx,scored)=>{
    setGame(g=>{
      const shots=[...(g.penalties?.shots||[]),{teamIdx:kickTeamIdx,playerIdx:kickerPlayerIdx,scored}];
      const t0=shots.filter(s=>s.teamIdx===0),t1=shots.filter(s=>s.teamIdx===1);
      const t0g=t0.filter(s=>s.scored).length,t1g=t1.filter(s=>s.scored).length;
      let finished=false,phase=g.penalties?.phase||'series';
      if(phase==='series'&&t0.length>=3&&t1.length>=3&&t0g!==t1g)finished=true;
      if(phase==='series'&&t0.length>=3&&t1.length>=3&&t0g===t1g)phase='sudden';
      if(phase==='sudden'&&t0.length===t1.length&&shots.slice(-2).length===2&&shots.slice(-2)[0].scored!==shots.slice(-2)[1].scored)finished=true;
      const entry={id:Date.now(),q:'PEN',time:'—',team:g.teams[kickTeamIdx].name,player:kickerPlayerIdx!==null?`#${g.teams[kickTeamIdx].players[kickerPlayerIdx].number} ${g.teams[kickTeamIdx].players[kickerPlayerIdx].name.split(' ')[0]}`:'—',action:scored?'⚽ Pênalti convertido':'✕ Pênalti perdido',pts:scored?1:0,color:scored?'#22c55e':'#ef4444'};
      return{...g,penalties:{shots,phase},log:[entry,...g.log],finished:finished?true:g.finished};
    });
  },[]);

  // ── renderTeamPanel ───────────────────────────────────────────────────────────
  const renderTeamPanel=(teamIdx)=>{
    const team=game.teams[teamIdx];
    const pIdx=teamIdx===0?selectedPlayerA:selectedPlayerB;
    return(
      <div className="team-panel">
        <div className="team-title">{team.name}</div>
        <div className="players-grid">
          {team.players.map((p,pi)=>(
            <button key={pi} className="player-btn"
              data-active={(teamIdx===0?selectedPlayerA:selectedPlayerB)===pi}
              data-bench={!p.active} data-disq={p.redCard}
              onClick={()=>{setActiveTeam(teamIdx);if(teamIdx===0)setSelectedPlayerA(pi);else setSelectedPlayerB(pi);}}>
              <span className="pnum">#{p.number}</span>
              <span className="pname">{p.name.split(' ')[0]}</span>
              <span className="ppts">{p.goals}g</span>
              {p.yellowCards>0&&!p.redCard&&<span style={{fontSize:'10px'}}>{'🟡'.repeat(p.yellowCards)}</span>}
              {p.redCard&&<span style={{fontSize:'10px'}}>🟥</span>}
            </button>
          ))}
        </div>
        <section className="actions-section">
          <div className="actions-group">
            <div className="actions-group-label">Ações</div>
            <div className="actions-row wrap">
              {[['passOk','P✓','#22c55e'],['passFail','P✕','#ef4444'],['steals','Roubo','#10b981'],['losses','Perda','#f97316'],['saves','Defesa','#3b82f6']].map(([id,label,color])=>(
                <button key={id} className="action-btn" style={{'--ac':color}} onClick={()=>{setActiveTeam(teamIdx);applyAction(id,teamIdx);}}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="actions-group">
            <div className="actions-group-label">Infrações</div>
            <div className="actions-row wrap">
              <button className="action-btn" style={{'--ac':'#f97316'}} onClick={()=>{setActiveTeam(teamIdx);if(pIdx===null){showToast('Selecione um atleta');return;}setFoulPending(true);}}>Falta</button>
              <button className="action-btn" style={{'--ac':'#eab308'}} onClick={()=>{setActiveTeam(teamIdx);if(pIdx===null){showToast('Selecione um atleta');return;}setCardPending(true);}}>Cartão</button>
              <button className="action-btn" style={{'--ac':'#64748b'}} onClick={()=>{setActiveTeam(teamIdx);if(pIdx===null){showToast('Selecione atleta que SAI');return;}setSubModal({outIdx:pIdx});}}>↕ Sub</button>
            </div>
          </div>
        </section>
      </div>
    );
  };

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
      {showAdmin&&<AdminScreen onClose={()=>setShowAdmin(false)}/>}
      <div className="home-screen">
        <div className="home-logo">
          <div className="logo-ball"><svg viewBox="0 0 60 60" width="60" height="60"><circle cx="30" cy="30" r="28" fill="#22c55e" stroke="#16a34a" strokeWidth="1"/><text x="30" y="40" fill="white" fontSize="28" textAnchor="middle" fontWeight="bold">⚽</text></svg></div>
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
          {isAdmin&&<button className="btn-teams" style={{background:'rgba(250,233,42,.1)',borderColor:'var(--accent)',color:'var(--accent)'}} onClick={()=>setShowAdmin(true)}>⚙ ADM</button>}
          <button className="btn-teams" onClick={()=>setShowTeams(true)}>
            ⚑ Times
            {teamsSyncStatus==='pending'&&<span className="teams-sync-dot pending">●</span>}
            {teamsSyncStatus==='saved'&&<span className="teams-sync-dot saved">✓</span>}
          </button>
        </div>
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
            {games.slice(0,8).map(g=>(
              <div key={g.id} className="game-card" style={{position:'relative'}} onClick={()=>{setGame(g);setScreen('game');setView('scout');setActiveTeam(0);setSelectedPlayerA(null);setSelectedPlayerB(null);setRunning(false);}}>
                <div className="game-card-teams"><span>{g.teams[0].name}</span><span className="game-card-score">{g.teams[0].score} — {g.teams[1].score}</span><span>{g.teams[1].name}</span></div>
                <div className="game-card-meta">
                  <span>{g.gameDate||g.date}</span>
                  <span style={{color:g.gameType==='competicao'?'var(--accent)':'var(--muted)',fontWeight:g.gameType==='competicao'?700:400}}>{g.gameType==='competicao'?`🏆 ${g.competitionName||'Competição'}`:'Amistoso'}</span>
                  <div className="export-btns" onClick={e=>e.stopPropagation()}>
                    <button className="export-btn" onClick={()=>exportStatsCSV(g)}>Stats</button>
                    <button className="export-btn green" onClick={()=>exportShotsCSV(g)}>Fin.</button>
                    <button className="export-btn" style={{color:'var(--blue)',borderColor:'rgba(59,130,246,.3)'}} onClick={()=>{const b=new Blob([JSON.stringify(g,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=`${g.teams[0].name}_vs_${g.teams[1].name}.json`;a.click();}}>JSON</button>
                  </div>
                </div>
                <button className="delete-game-btn" onClick={async e=>{e.stopPropagation();if(!window.confirm('Excluir?'))return;await deleteGame(g.id).catch(()=>{});setGames(prev=>{const n=prev.filter(x=>x.id!==g.id);saveGames(n,user?.id);return n;});}}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  // ── GAME SCREEN ───────────────────────────────────────────────────────────────
  const td=game.teams[activeTeam];
  const sp=selectedPlayer!==null?td.players[selectedPlayer]:null;
  const tfq=(game.teamFouls?.[activeTeam]||[])[game.quarter]||0;
  const inBonus=tfq>=FOUL_BONUS;
  const activeShots=sp?(sp.shots||[]):td.players.flatMap(p=>p.shots||[]);

  return(
    <div className="app">
      {toast&&<div className="toast">{toast}</div>}

      {/* Modais */}
      {confirmShot&&<ConfirmShotModal onGoal={()=>{const s=confirmShot;setConfirmShot(null);setAssistPending({scorerIdx:selectedPlayer,xPct:s.xPct,yPct:s.yPct});}} onMiss={()=>{const s=confirmShot;setConfirmShot(null);commitShot(selectedPlayer,s.xPct,s.yPct);}} onCancel={()=>setConfirmShot(null)}/>}
      {assistPending&&<AssistModal players={td.players} scorerIdx={assistPending.scorerIdx} onSelect={aIdx=>commitGoal(assistPending.scorerIdx,assistPending.xPct,assistPending.yPct,aIdx)} onNone={()=>commitGoal(assistPending.scorerIdx,assistPending.xPct,assistPending.yPct,null)} onCancel={()=>setAssistPending(null)}/>}
      {cardPending&&sp&&<CardModal player={sp} yellowCount={sp.yellowCards||0} onYellow={()=>commitCard(false)} onRed={()=>commitCard(true)} onCancel={()=>setCardPending(false)}/>}
      {foulPending&&<FoulModal teamName={td.name} foulCount={tfq} onConfirm={()=>commitFoul(activeTeam)} onCancel={()=>setFoulPending(false)}/>}
      {directFKPending&&<DirectFKModal fouledTeam={game.teams[directFKPending.fouledTeamIdx].name} players={game.teams[directFKPending.fouledTeamIdx].players} onSelectShooter={idx=>{setDirectFKPending(null);setDirectFKShooter({teamIdx:directFKPending.fouledTeamIdx,playerIdx:idx});}} onCancel={()=>setDirectFKPending(null)}/>}
      {directFKShooter&&<DirectFKResultModal shooter={directFKShooter.playerIdx!==null?game.teams[directFKShooter.teamIdx].players[directFKShooter.playerIdx]:null}
        onGoal={()=>{
          const{teamIdx,playerIdx}=directFKShooter;
          setGameWithUndo(g=>{const teams=g.teams.map((t,ti)=>{if(ti!==teamIdx)return{...t,players:t.players.map(p=>({...p,plusMinus:(p.plusMinus||0)-(p.active?1:0)}))};return{...t,score:t.score+1,players:t.players.map((p,pi)=>{const n={...p};if(pi===playerIdx){n.goals++;n.shotsOn++;}if(p.active)n.plusMinus=(n.plusMinus||0)+1;return n;})};});const pl=playerIdx!==null?g.teams[teamIdx].players[playerIdx]:null;const entry={id:Date.now(),q:getQuarterLabel(g.quarter),time:fmtTime(g.clock),team:g.teams[teamIdx].name,player:pl?`#${pl.number} ${pl.name.split(' ')[0]}`:'—',action:'⚽ GOL (TLD)',pts:1,color:'#22c55e'};return{...g,teams,log:[entry,...g.log]};});
          showToast('⚽ GOL — Tiro Livre Direto!');setActiveTeam(t=>1-t);setSelectedPlayerA(null);setSelectedPlayerB(null);setDirectFKShooter(null);
        }}
        onMiss={()=>{showToast('TLD — não convertido');setDirectFKShooter(null);}}
        onCancel={()=>setDirectFKShooter(null)}/>}
      {subModal&&<SubModal players={td.players} outPlayerIdx={subModal.outIdx} onSub={executeSub} onCancel={()=>setSubModal(null)}/>}
      {showPeriodEnd&&<PeriodEndModal quarter={game.quarter} scores={[game.teams[0].score,game.teams[1].score]}
        onContinue={()=>{setGame(g=>{const nq=g.quarter+1;const nc=nq>=2?OT_TIME:PERIOD_TIME;const tf=g.teamFouls.map(t=>{const a=[...t];while(a.length<=nq)a.push(0);return a;});return{...g,quarter:nq,clock:nc,teamFouls:tf};});setShowPeriodEnd(false);setRunning(true);}}
        onOvertime={()=>{setGame(g=>{const nq=g.quarter+1;const tf=g.teamFouls.map(t=>{const a=[...t];while(a.length<=nq)a.push(0);return a;});return{...g,quarter:nq,clock:OT_TIME,teamFouls:tf};});setShowPeriodEnd(false);setRunning(true);}}
        onPenalties={()=>{setGame(g=>({...g,penalties:{shots:[],phase:'series'}}));setShowPeriodEnd(false);setShowPenalty(true);}}
        onFinish={()=>{setGame(g=>({...g,finished:true}));setShowPeriodEnd(false);}}/>}
      {showPenalty&&game.penalties&&<PenaltyModal game={game} startTeam={game.firstPossTeam||0} onShot={handlePenaltyShot} onFinish={()=>{setShowPenalty(false);setGame(g=>({...g,finished:true}));}}/>}

      {/* Header */}
      <header className="header">
        <div className="header-top">
          <button className="back-btn" onClick={()=>{setRunning(false);setScreen('home');}}>‹ Voltar</button>
          <div className="header-game-label">
            {game.teams[0].name} vs {game.teams[1].name}
            {user&&running&&<span className="sync-badge online">● ao vivo</span>}
            {user&&!running&&syncStatus==='syncing'&&<span className="sync-badge syncing">↑ salvando</span>}
            {user&&!running&&syncStatus==='saved'&&<span className="sync-badge saved">✓ salvo</span>}
          </div>
          <div className="export-btns">
            <button className="export-btn-sm" onClick={()=>exportStatsCSV(game)}>Stats</button>
            <button className="export-btn-sm green" onClick={()=>exportShotsCSV(game)}>Fin.</button>
            <button className="export-btn-sm" onClick={()=>exportLogCSV(game)}>Log</button>
          </div>
        </div>

        <div className="scoreboard">
          <div className="team-score-wrap">
            <div className="team-score" data-active={activeTeam===0} onClick={()=>{setActiveTeam(0);setSelectedPlayerA(null);setSelectedPlayerB(null);}}>
              <span className="team-name">{game.teams[0].name}</span>
              <span className="score">{game.teams[0].score}</span>
              <div className="team-foul-dots">
                {[1,2,3,4,5,6].map(n=><span key={n} className="foul-dot" data-filled={((game.teamFouls?.[0]||[])[game.quarter]||0)>=n} data-bonus={n===FOUL_BONUS}/>)}
              </div>
            </div>
            <button className="sub-score-btn" onClick={()=>{setActiveTeam(0);if(selectedPlayerA===null){showToast('Selecione atleta');return;}setSubModal({outIdx:selectedPlayerA});}}>↕</button>
          </div>
          <div className="center-info">
            <span className="quarter-label">{getQuarterLabel(game.quarter)}</span>
            <div className="clock-row">
              <button className={`clock-play-btn ${running?'playing':'paused'}`} onClick={()=>setRunning(r=>!r)}>{running?'⏸':'▶'}</button>
              <div className="clock">{fmtTime(game.clock)}</div>
              <button className="next-q-btn" onClick={()=>{if(game.clock>0){showToast(`Faltam ${fmtTime(game.clock)}`);return;}setShowPeriodEnd(true);}}>
                {game.clock>0?'›T':'›End'}
              </button>
              <button className="undo-btn-clock" onClick={undoLastAction} title="Desfazer">↩</button>
            </div>
          </div>
          <div className="team-score-wrap">
            <button className="sub-score-btn" onClick={()=>{setActiveTeam(1);if(selectedPlayerB===null){showToast('Selecione atleta');return;}setSubModal({outIdx:selectedPlayerB});}}>↕</button>
            <div className="team-score right" data-active={activeTeam===1} onClick={()=>{setActiveTeam(1);setSelectedPlayerA(null);setSelectedPlayerB(null);}}>
              <span className="score">{game.teams[1].score}</span>
              <span className="team-name">{game.teams[1].name}</span>
              <div className="team-foul-dots">
                {[1,2,3,4,5,6].map(n=><span key={n} className="foul-dot" data-filled={((game.teamFouls?.[1]||[])[game.quarter]||0)>=n} data-bonus={n===FOUL_BONUS}/>)}
              </div>
            </div>
          </div>
        </div>

        {inBonus&&<div className="bonus-bar">⚠️ TIRO LIVRE DIRETO — {td.name} ({tfq} faltas no {getQuarterLabel(game.quarter)})</div>}

        <nav className="nav">
          {[['scout','Scout'],['stats','Stats'],['heatmap','Mapa'],['log','Log']].map(([v,l])=>(
            <button key={v} className="nav-btn" data-active={view===v} onClick={()=>setView(v)}>{l}</button>
          ))}
        </nav>
      </header>

      {game.finished&&(()=>{const[s0,s1]=[game.teams[0].score,game.teams[1].score];const winner=s0>s1?game.teams[0].name:s1>s0?game.teams[1].name:'Empate';return(<div className="game-over-banner"><div className="game-over-title">Jogo Finalizado</div><div className="game-over-winner">{winner}</div><div className="game-over-score">{s0} — {s1}</div><button className="game-over-reset" onClick={()=>setGame(g=>({...g,finished:false}))}>Continuar editando</button></div>);})()}

      {/* Scout */}
      {view==='scout'&&(
        <main className="scout-view" style={{flex:1,overflow:'hidden',display:'flex',flexDirection:'column'}}>
          {sp&&<div className="selected-bar"><span className="sel-badge">#{sp.number} {sp.name} {sp.position?`(${sp.position})`:''}</span><div className="sel-mini-stats">
            {[['GOL',sp.goals],['AST',sp.assists],['FIN✓',sp.shotsOn],['FIN✕',sp.shotsOff],['P✓',sp.passOk],['P✕',sp.passFail],['ROB',sp.steals],['PERD',sp.losses]].map(([k,v])=><span key={k} className="mini-stat"><b>{v}</b>{k}</span>)}
            {sp.yellowCards>0&&<span className="mini-stat"><b>{sp.yellowCards}</b>🟡</span>}
            {sp.redCard&&<span className="mini-stat"><b>EXP</b>🟥</span>}
          </div></div>}
          <section className="court-section" style={{display:'flex',flexDirection:'column',flex:1,minHeight:0}}>
            <div className="court-section-header">
              <div className="section-label">{selectedPlayer!==null?`Toque para registrar finalização`:'Selecione um atleta'}</div>
            </div>
            <div className="game-layout" style={{flex:1,minHeight:0}}>
              {renderTeamPanel(0)}
              <div className="court-container">
                <FutsalCourt shots={activeShots} onCourtClick={handleCourtClick} hasPlayer={selectedPlayer!==null} attackDir={getAttackDir(activeTeam,game.quarter,game.homeAttackRight??true)}/>
              </div>
              {renderTeamPanel(1)}
            </div>
            {activeShots.length>0&&(()=>{const on=activeShots.filter(s=>s.on).length;return(<div className="shot-summary-full"><div className="shot-sum-row"><span className="shot-sum-label">FIN%</span><span className="shot-sum-val">{pct(on,activeShots.length)}</span><span className="shot-sum-sub">{on}/{activeShots.length}</span></div><div className="shot-sum-divider"/><div className="shot-sum-row"><span className="shot-sum-label">Gols</span><span className="shot-sum-val" style={{color:'#22c55e'}}>{on}</span></div><div className="shot-sum-divider"/><div className="shot-sum-row"><span className="shot-sum-label">Fora</span><span className="shot-sum-val" style={{color:'#ef4444'}}>{activeShots.length-on}</span></div></div>);})()} 
          </section>
        </main>
      )}

      {/* Stats */}
      {view==='stats'&&(
        <main className="stats-view">
          <div className="fouls-summary">
            <div className="fouls-summary-title">Faltas coletivas</div>
            <table className="fouls-table"><thead><tr><th>Time</th>{Array.from({length:game.quarter+1},(_,i)=><th key={i}>{getQuarterLabel(i)}</th>)}<th>Tot.</th></tr></thead>
            <tbody>{game.teams.map((t,ti)=>{const tf=game.teamFouls?.[ti]||[];return<tr key={ti}><td className="player-cell">{t.name}</td>{Array.from({length:game.quarter+1},(_,qi)=><td key={qi} data-warn={(tf[qi]||0)>=FOUL_BONUS}>{tf[qi]||0}</td>)}<td>{tf.reduce((a,b)=>a+b,0)}</td></tr>;})}
            </tbody></table>
          </div>
          {game.teams.map((team,ti)=>{
            const active=team.players.filter(p=>p.active||p.goals||p.assists||p.shotsOn||p.shotsOff||p.passOk||p.passFail||p.steals||p.losses||(p.timeOnCourt||0)>0);
            const tot=active.reduce((acc,p)=>{['goals','assists','shotsOn','shotsOff','passOk','passFail','steals','losses','fouls','yellowCards','saves'].forEach(k=>acc[k]=(acc[k]||0)+(p[k]||0));return acc;},{});
            return(
              <div key={ti} className="stats-block">
                <div className="stats-header"><span>{team.name}</span><span className="stats-total-score">{team.score} gols</span></div>
                {active.length>0&&<div className="table-wrap"><table className="stats-table">
                  <thead><tr>
                    <th title="Atleta">Atleta</th><th title="Posição">Pos</th><th title="Minutos">MIN</th>
                    <th title="Gols">GOL</th><th title="Assistências">AST</th>
                    <th title="Finalizações certas">FIN✓</th><th title="Finalizações erradas">FIN✕</th><th title="Aproveitamento">FIN%</th>
                    <th title="Passes certos">P✓</th><th title="Passes errados">P✕</th><th title="Precisão passes">P%</th>
                    <th title="Roubos de bola">ROB</th><th title="Perdas de bola">PERD</th>
                    <th title="Faltas">FAL</th><th title="Amarelos">🟡</th><th title="Vermelho">🟥</th>
                    <th title="Defesas goleiro">DEF</th><th title="Plus/Minus">+/-</th>
                  </tr></thead>
                  <tbody>{active.map(p=>(
                    <tr key={p.id} data-disq={p.redCard}>
                      <td className="player-cell"><span className="num-badge">#{p.number}</span>{p.name}{p.redCard&&<span className="disq-tag">EXP</span>}</td>
                      <td style={{fontSize:'11px',color:'var(--muted)'}}>{p.position||''}</td>
                      <td className="min-cell">{Math.floor((p.timeOnCourt||0)/60)}:{String(Math.round((p.timeOnCourt||0)%60)).padStart(2,'0')}</td>
                      <td className="pts-cell">{p.goals}</td><td>{p.assists}</td>
                      <td>{p.shotsOn}</td><td>{p.shotsOff}</td><td>{pct(p.shotsOn,(p.shotsOn||0)+(p.shotsOff||0))}</td>
                      <td>{p.passOk}</td><td>{p.passFail}</td><td>{pct(p.passOk,(p.passOk||0)+(p.passFail||0))}</td>
                      <td>{p.steals}</td><td data-warn={(p.losses||0)>3}>{p.losses}</td>
                      <td>{p.fouls}</td><td>{p.yellowCards||0}</td><td>{p.redCard?'🟥':''}</td>
                      <td style={{color:'var(--blue)'}}>{p.saves||0}</td>
                      <td className={(p.plusMinus||0)>0?'pm-pos':(p.plusMinus||0)<0?'pm-neg':''}>{(p.plusMinus||0)>=0?`+${p.plusMinus||0}`:p.plusMinus||0}</td>
                    </tr>
                  ))}</tbody>
                  <tfoot><tr><td>Total</td><td></td><td></td><td className="pts-cell">{tot.goals}</td><td>{tot.assists}</td><td>{tot.shotsOn}</td><td>{tot.shotsOff}</td><td>{pct(tot.shotsOn||0,(tot.shotsOn||0)+(tot.shotsOff||0))}</td><td>{tot.passOk}</td><td>{tot.passFail}</td><td>{pct(tot.passOk||0,(tot.passOk||0)+(tot.passFail||0))}</td><td>{tot.steals}</td><td>{tot.losses}</td><td>{tot.fouls}</td><td>{tot.yellowCards}</td><td></td><td>{tot.saves}</td><td></td></tr></tfoot>
                </table></div>}
              </div>
            );
          })}
          {game.penalties?.shots?.length>0&&(
            <div className="stats-block">
              <div className="stats-header"><span>Disputa de Pênaltis</span></div>
              <div style={{padding:'8px 12px'}}>
                {game.penalties.shots.map((s,i)=>{const pl=s.playerIdx!==null?game.teams[s.teamIdx].players[s.playerIdx]:null;return(<div key={i} style={{display:'flex',alignItems:'center',gap:'8px',padding:'5px 0',borderBottom:'1px solid var(--border)'}}><span style={{fontSize:'16px'}}>{s.scored?'⚽':'✕'}</span><span style={{color:'var(--muted)',fontSize:'12px'}}>{game.teams[s.teamIdx].name}</span><span style={{fontWeight:700}}>{pl?`#${pl.number} ${pl.name.split(' ')[0]}`:'—'}</span></div>);})}
              </div>
            </div>
          )}
        </main>
      )}

      {/* Heatmap */}
      {view==='heatmap'&&(
        <main className="heatmap-view">
          {game.teams.map((team,ti)=>(
            <HeatMap key={ti} shots={team.players.flatMap(p=>p.shots||[])} teamName={team.name} teamIdx={ti} homeAttackRight={game.homeAttackRight??true}/>
          ))}
        </main>
      )}

      {/* Log */}
      {view==='log'&&(
        <main className="log-view">
          <div className="log-top"><span>{game.log.length} eventos</span>{game.log.length>0&&<button className="clear-btn" onClick={()=>window.confirm('Limpar?')&&setGame(g=>({...g,log:[]}))}>Limpar</button>}</div>
          {game.log.length===0&&<div className="empty-log">Sem eventos.</div>}
          <div className="log-list">
            {game.log.map(e=>(
              <div key={e.id} className="log-entry">
                <div className="log-meta"><span className="log-q">{e.q}</span><span>{e.time}</span><span className="log-team-name">{e.team}</span></div>
                <div className="log-body"><span className="log-player">{e.player}</span><span className="log-action" style={{color:e.color}}>{e.action}</span>{e.pts>0&&<span className="log-pts">+{e.pts}</span>}</div>
              </div>
            ))}
          </div>
        </main>
      )}
    </div>
  );
}
