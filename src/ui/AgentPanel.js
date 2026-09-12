// ── AgentPanel ───────────────────────────────────────────────────────────────
//  Viewer-side chat panel: the mayor's narration and tool calls, viewer
//  messages, and the token/cost ledger. Plain DOM, loaded straight from
//  watch.html (no rebuild needed). Talks to the server through
//  window.cityRemote (set by WorkerBridge in remote mode) and listens to the
//  'city-agent' window events it dispatches.
// ─────────────────────────────────────────────────────────────────────────────

const CSS = `
#agent { position:absolute; right:12px; top:104px; bottom:12px; width:360px; max-width:calc(100vw - 24px);
  display:flex; flex-direction:column; background:var(--c-surface, rgba(20,30,48,.85)); border:1px solid var(--c-border, rgba(100,160,220,.22));
  border-radius:10px; color:var(--c-text, #dce8f5); font:13px/1.4 var(--font-ui, system-ui, sans-serif); pointer-events:auto; z-index:20; backdrop-filter:blur(6px); }
#agent.collapsed { bottom:auto; }
#agent.collapsed #agent-log, #agent.collapsed #agent-form { display:none; }
#agent-head { display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid var(--c-border, rgba(100,160,220,.22)); cursor:pointer; }
#agent-head b { flex:1; font-weight:600; }
#agent-ledger { font-size:11px; color:var(--c-text-dim, rgba(180,210,240,.6)); white-space:nowrap; }
#agent-log { flex:1; overflow-y:auto; padding:8px 10px; display:flex; flex-direction:column; gap:6px; scrollbar-width:thin; }
.ae { padding:6px 9px; border-radius:8px; max-width:100%; word-wrap:break-word; }
.ae.say { background:rgba(74,158,221,.22); border-left:3px solid var(--c-accent, #4a9edd); }
.ae.text { color:var(--c-text-dim, rgba(180,210,240,.6)); font-style:italic; }
.ae.tool { font:11px/1.35 ui-monospace, Menlo, Consolas, monospace; color:var(--c-text-info, #C0CAC6); background:rgba(0,0,0,.18); }
.ae.tool.err { color:#f0a0a0; }
.ae.user { background:rgba(120,200,120,.18); border-left:3px solid #6c6; align-self:flex-end; }
.ae.user b { color:#9e9; }
.ae.status, .ae.error { font-size:11px; color:var(--c-text-dim, rgba(180,210,240,.6)); text-align:center; }
.ae.error { color:#f0a0a0; }
#agent-form { display:flex; gap:6px; padding:8px 10px; border-top:1px solid var(--c-border, rgba(100,160,220,.22)); }
#agent-form input { background:rgba(0,0,0,.25); border:1px solid var(--c-border, rgba(100,160,220,.22)); color:inherit; border-radius:6px; padding:6px 8px; font:inherit; }
#agent-name { width:72px; }
#agent-text { flex:1; }
#agent-form button { background:var(--c-accent, #4a9edd); color:#fff; border:0; border-radius:6px; padding:6px 10px; font:inherit; cursor:pointer; }
`;

export class AgentPanel {

    constructor () {
        const style = document.createElement( 'style' ); style.textContent = CSS; document.head.appendChild( style );
        const el = this.el = document.createElement( 'div' ); el.id = 'agent';
        el.innerHTML = `
            <div id="agent-head"><b id="agent-title">Mayor</b><span id="agent-ledger">connecting…</span></div>
            <div id="agent-log"></div>
            <form id="agent-form"><input id="agent-name" placeholder="name" maxlength="24"><input id="agent-text" placeholder="say something to the mayor…" maxlength="500" autocomplete="off"><button>Send</button></form>`;
        document.body.appendChild( el );
        this.log = el.querySelector( '#agent-log' );
        this.ledgerEl = el.querySelector( '#agent-ledger' );
        this.titleEl = el.querySelector( '#agent-title' );
        this.nameEl = el.querySelector( '#agent-name' );
        this.textEl = el.querySelector( '#agent-text' );
        try { this.nameEl.value = localStorage.getItem( 'city-name' ) || ''; } catch {}

        el.querySelector( '#agent-head' ).onclick = () => el.classList.toggle( 'collapsed' );
        el.querySelector( '#agent-form' ).onsubmit = ( e ) => { e.preventDefault(); this.send(); };
        // Keep game hotkeys from firing while typing.
        el.addEventListener( 'keydown', ( e ) => e.stopPropagation() );

        window.addEventListener( 'city-agent', ( e ) => this.onMessage( e.detail ) );
    }

    send () {
        const text = this.textEl.value.trim();
        if ( !text || !window.cityRemote ) return;
        const name = this.nameEl.value.trim() || 'viewer';
        try { localStorage.setItem( 'city-name', name ); } catch {}
        window.cityRemote.send( { tell: 'CHAT', name, text } );
        this.textEl.value = '';
    }

    onMessage ( d ) {
        if ( d.tell === 'AGENT_SYNC' ) {
            this.log.innerHTML = '';
            this.titleEl.textContent = `Mayor · ${ d.driver || 'no agent' }${ d.paused ? ' (paused)' : '' }`;
            for ( const e of d.entries || [] ) this.add( e, false );
            this.ledger( d.ledger, d.limits );
            this.scroll();
        } else if ( d.tell === 'AGENT' ) {
            this.add( d.entry, true );
        } else if ( d.tell === 'LEDGER' ) {
            this.ledger( d.ledger );
        }
    }

    add ( e, scroll ) {
        const div = document.createElement( 'div' );
        div.className = 'ae ' + e.kind + ( e.kind === 'tool' && !e.ok ? ' err' : '' );
        if ( e.kind === 'say' || e.kind === 'text' || e.kind === 'status' || e.kind === 'error' ) div.textContent = e.text;
        else if ( e.kind === 'user' ) { const b = document.createElement( 'b' ); b.textContent = e.name + ': '; div.append( b, e.text ); }
        else if ( e.kind === 'tool' ) div.textContent = `${ e.name }(${ fmtArgs( e.args ) })${ e.ok ? '' : ' ✗ ' + e.result }`;
        this.log.appendChild( div );
        while ( this.log.children.length > 200 ) this.log.firstChild.remove();
        if ( scroll ) this.scroll();
    }

    ledger ( l, limits ) {
        if ( !l ) { this.ledgerEl.textContent = 'no agent'; return; }
        const inTok = l.input + l.cacheRead + l.cacheWrite;
        let s = `${ k( inTok ) } in · ${ k( l.output ) } out · ${ l.priced === false ? 'cost n/a' : ( l.estimated ? '~' : '' ) + '$' + l.costUsd.toFixed( 2 ) }`;
        if ( limits && limits.fiveHour != null ) s += ` · 5h ${ Math.round( limits.fiveHour * 100 ) }%`;
        this.ledgerEl.textContent = s;
        this.ledgerEl.title = `${ l.model || '' }\n${ l.turns } turns, ${ l.steps } model calls${ l.estimated ? ' (cost estimated from token prices)' : '' }\ninput ${ l.input }, cache read ${ l.cacheRead }, cache write ${ l.cacheWrite }, output ${ l.output }`;
    }

    scroll () {
        const nearBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 80;
        if ( nearBottom ) this.log.scrollTop = this.log.scrollHeight;
    }

}

function fmtArgs ( a ) {
    if ( !a ) return '';
    return Object.entries( a ).map( ( [ k, v ] ) => `${ k }=${ typeof v === 'string' ? v : JSON.stringify( v ) }` ).join( ', ' );
}

function k ( n ) { return n >= 1e6 ? ( n / 1e6 ).toFixed( 2 ) + 'M' : n >= 1e3 ? ( n / 1e3 ).toFixed( 1 ) + 'k' : String( n ); }
