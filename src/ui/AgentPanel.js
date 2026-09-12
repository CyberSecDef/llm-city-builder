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
#agent.collapsed { bottom:auto; height:auto !important; }
#agent-head { cursor:move; user-select:none; touch-action:none; }
#agent.collapsed #agent-log, #agent.collapsed #agent-form { display:none; }
#agent-head { display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid var(--c-border, rgba(100,160,220,.22)); cursor:pointer; }
#agent-head b { flex:1; font-weight:600; }
#agent-ledger { font-size:11px; color:var(--c-text-dim, rgba(180,210,240,.6)); white-space:nowrap; }
#agent-key { font-size:12px; opacity:.55; cursor:pointer; }
#agent-key:hover, #agent.owner #agent-key { opacity:1; }
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
#agent-state { display:none; padding:5px 10px; font-size:11px; text-align:center; background:rgba(240,180,80,.18); color:#f5d08a; border-bottom:1px solid var(--c-border, rgba(100,160,220,.22)); }
#agent-state.on { display:block; }
#agent-admin { display:none; flex-wrap:wrap; gap:6px; padding:6px 10px; border-bottom:1px solid var(--c-border, rgba(100,160,220,.22)); font-size:11px; align-items:center; }
#agent.owner #agent-admin { display:flex; }
#agent.collapsed #agent-admin, #agent.collapsed #agent-state { display:none; }
#agent-admin button, #agent-admin select, #agent-admin input { background:rgba(0,0,0,.25); border:1px solid var(--c-border, rgba(100,160,220,.22)); color:inherit; border-radius:5px; padding:3px 7px; font:inherit; cursor:pointer; }
#agent-admin button.primary { background:var(--c-accent, #4a9edd); border-color:transparent; color:#fff; }
#agent-admin button.danger { border-color:rgba(240,120,120,.5); color:#f0a0a0; }
#agent-admin input { width:52px; cursor:text; }
#agent-admin .sep { flex:1; }
#agent-admin .note { width:100%; color:var(--c-text-dim, rgba(180,210,240,.6)); }
`;

export class AgentPanel {

    constructor () {
        const style = document.createElement( 'style' ); style.textContent = CSS; document.head.appendChild( style );
        const el = this.el = document.createElement( 'div' ); el.id = 'agent';
        el.innerHTML = `
            <div id="agent-head"><b id="agent-title">Mayor</b><span id="agent-ledger">connecting…</span><span id="agent-key" title="owner token">🔑</span></div>
            <div id="agent-state"></div>
            <div id="agent-admin">
                <button id="adm-pause" class="primary">Pause</button>
                <button id="adm-save">Save</button>
                <label>cap $<input id="adm-cap" type="number" min="0" step="1"></label><button id="adm-setcap">Set</button>
                <span class="sep"></span>
                <select id="adm-size"><option value="64x64">64²</option><option value="128x128" selected>128²</option><option value="256x256">256²</option></select>
                <button id="adm-new" class="danger">New game</button>
                <button id="adm-stop" class="danger">Stop</button>
                <span class="note" id="adm-note">owner controls</span>
            </div>
            <div id="agent-log"></div>
            <form id="agent-form"><input id="agent-name" placeholder="name" maxlength="24"><input id="agent-text" placeholder="say something to the mayor…" maxlength="500" autocomplete="off"><button>Send</button></form>`;
        document.body.appendChild( el );
        this.log = el.querySelector( '#agent-log' );
        this.ledgerEl = el.querySelector( '#agent-ledger' );
        this.titleEl = el.querySelector( '#agent-title' );
        this.nameEl = el.querySelector( '#agent-name' );
        this.textEl = el.querySelector( '#agent-text' );
        this.stateEl = el.querySelector( '#agent-state' );
        this.noteEl = el.querySelector( '#adm-note' );
        this.state = null;
        try { this.nameEl.value = localStorage.getItem( 'city-name' ) || ''; } catch {}
        this._initAdmin( el );

        el.querySelector( '#agent-head' ).onclick = () => { if ( this._dragged ) { this._dragged = false; return; } el.classList.toggle( 'collapsed' ); };
        this._initDrag( el );
        el.querySelector( '#agent-form' ).onsubmit = ( e ) => { e.preventDefault(); this.send(); };
        // Keep game hotkeys from firing while typing.
        el.addEventListener( 'keydown', ( e ) => e.stopPropagation() );

        window.addEventListener( 'city-agent', ( e ) => this.onMessage( e.detail ) );
    }

    // ?admin=<token> once, then it lives in localStorage and the URL is cleaned.
    // Drag the panel by its header. Position is remembered per browser;
    // double-click the header to put it back where it started.
    _initDrag ( el ) {
        const head = el.querySelector( '#agent-head' );
        let start = null;
        const place = ( left, top, h ) => {
            const r = el.getBoundingClientRect();
            left = Math.max( 0, Math.min( left, window.innerWidth - r.width ) );
            top = Math.max( 0, Math.min( top, window.innerHeight - 44 ) );
            el.style.left = left + 'px'; el.style.top = top + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto';
            if ( h ) el.style.height = Math.min( h, window.innerHeight - top - 12 ) + 'px';
        };
        head.addEventListener( 'pointerdown', ( e ) => {
            if ( e.button !== 0 || e.target.id === 'agent-key' ) return;
            const r = el.getBoundingClientRect();
            start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, h: r.height, moved: false };
            head.setPointerCapture( e.pointerId );
        } );
        head.addEventListener( 'pointermove', ( e ) => {
            if ( !start ) return;
            const dx = e.clientX - start.x, dy = e.clientY - start.y;
            if ( !start.moved && Math.hypot( dx, dy ) < 4 ) return;
            start.moved = true;
            place( start.left + dx, start.top + dy, el.classList.contains( 'collapsed' ) ? 0 : start.h );
        } );
        head.addEventListener( 'pointerup', () => {
            if ( !start ) return;
            if ( start.moved ) {
                this._dragged = true;
                try { localStorage.setItem( 'city-panel', JSON.stringify( { left: el.offsetLeft, top: el.offsetTop, h: el.classList.contains( 'collapsed' ) ? 0 : el.offsetHeight } ) ); } catch {}
            }
            start = null;
        } );
        head.addEventListener( 'dblclick', ( e ) => {
            if ( e.target.id === 'agent-key' ) return;
            el.style.left = el.style.top = el.style.right = el.style.bottom = el.style.height = '';
            try { localStorage.removeItem( 'city-panel' ); } catch {}
        } );
        window.addEventListener( 'resize', () => { if ( el.style.left ) place( el.offsetLeft, el.offsetTop, el.classList.contains( 'collapsed' ) ? 0 : el.offsetHeight ); } );
        try {
            const saved = JSON.parse( localStorage.getItem( 'city-panel' ) || 'null' );
            if ( saved ) place( saved.left, saved.top, saved.h || 0 );
        } catch {}
    }

    // The owner token comes from ?admin=<token> once, from the 🔑 button, or
    // from localStorage on later visits. Wrong or missing: viewer only.
    _initAdmin ( el ) {
        const url = new URL( location.href );
        const fromUrl = url.searchParams.get( 'admin' );
        if ( fromUrl ) {
            try { localStorage.setItem( 'city-admin', fromUrl ); } catch {}
            url.searchParams.delete( 'admin' ); history.replaceState( null, '', url );
        }
        try { this.token = localStorage.getItem( 'city-admin' ); } catch { this.token = null; }
        const admin = ( action, extra = {} ) => window.cityRemote?.send( { tell: 'ADMIN', token: this.token, action, ...extra } );
        el.querySelector( '#adm-pause' ).onclick = () => admin( this.state?.paused ? 'resume' : 'pause' );
        el.querySelector( '#adm-save' ).onclick = () => admin( 'save' );
        el.querySelector( '#adm-setcap' ).onclick = () => admin( 'set_cap', { usd: Number( el.querySelector( '#adm-cap' ).value ) } );
        el.querySelector( '#adm-new' ).onclick = () => { if ( confirm( 'Start a new game? The current city is replaced (the save file is overwritten at the next autosave).' ) ) admin( 'new_game', { mapSize: el.querySelector( '#adm-size' ).value } ); };
        el.querySelector( '#adm-stop' ).onclick = () => { if ( confirm( 'Stop the mayor? The clock keeps running; restart the server to bring it back.' ) ) admin( 'stop' ); };
        el.querySelector( '#agent-key' ).onclick = ( e ) => {
            e.stopPropagation();   // don't collapse the panel
            const cur = this.token || '';
            const t = prompt( cur ? 'Owner token (clear to sign out):' : 'Owner token (printed by the server at start):', cur );
            if ( t === null ) return;
            this.setToken( t.trim() );
        };
        this.setToken( this.token, true );
    }

    setToken ( token, silent ) {
        this.token = token || null;
        try { if ( this.token ) localStorage.setItem( 'city-admin', this.token ); else localStorage.removeItem( 'city-admin' ); } catch {}
        this.el.classList.toggle( 'owner', !!this.token );
        this.el.querySelector( '#agent-key' ).title = this.token ? 'owner token set (click to change)' : 'enter the owner token';
        if ( !silent && this.token ) { this.noteEl.textContent = 'token saved'; this.noteEl.style.color = ''; }
        if ( this.state ) this.setState( this.state );
    }

    setState ( st ) {
        this.state = st;
        const pauseBtn = this.el.querySelector( '#adm-pause' );
        if ( !st ) { this.stateEl.className = ''; pauseBtn.textContent = 'Pause'; return; }
        pauseBtn.textContent = st.paused ? 'Resume' : 'Pause';
        pauseBtn.disabled = !st.running;
        let text = '';
        if ( !st.running ) text = 'mayor stopped';
        else if ( st.paused && st.reason === 'budget' ) text = `spend cap $${ st.cap } reached — game paused`;
        else if ( st.paused ) text = 'paused by the owner — clock stopped';
        this.stateEl.textContent = text;
        this.stateEl.className = text ? 'on' : '';
        const capEl = this.el.querySelector( '#adm-cap' );
        if ( st.cap && document.activeElement !== capEl ) capEl.value = st.cap;
        this.ledger( this.lastLedger, this.lastLimits );
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
            this.titleEl.textContent = `Mayor · ${ d.driver || 'no agent' }`;
            for ( const e of d.entries || [] ) this.add( e, false );
            this.lastLimits = d.limits;
            this.ledger( d.ledger, d.limits );
            this.setState( d.state || null );
            this.log.scrollTop = this.log.scrollHeight;   // fresh sync: always start at the latest entry
        } else if ( d.tell === 'AGENT' ) {
            this.add( d.entry, true );
        } else if ( d.tell === 'LEDGER' ) {
            this.ledger( d.ledger, this.lastLimits );
        } else if ( d.tell === 'AGENT_STATE' ) {
            this.setState( d.state );
        } else if ( d.tell === 'ADMIN_RESULT' ) {
            this.noteEl.textContent = `${ d.action }: ${ d.text }` + ( d.text === 'bad token' ? ' — click 🔑 to enter the owner token' : '' );
            this.noteEl.style.color = d.ok ? '' : '#f0a0a0';
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
        this.lastLedger = l;
        if ( !l ) { this.ledgerEl.textContent = 'no agent'; return; }
        const inTok = l.input + l.cacheRead + l.cacheWrite;
        const cap = this.state?.cap;
        const cost = l.priced === false ? 'cost n/a' : ( l.estimated ? '~' : '' ) + '$' + l.costUsd.toFixed( 2 ) + ( cap ? ` / $${ cap }` : '' );
        let s = `${ k( inTok ) } in · ${ k( l.output ) } out · ${ cost }`;
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
