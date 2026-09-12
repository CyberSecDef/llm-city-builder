// ── TileInfo ─────────────────────────────────────────────────────────────────
//  Click card for remote viewers: what a tile is and what the sim knows
//  about it. Fed by the 'city-tile' window event WorkerBridge dispatches
//  when the server answers a QUERY_TILE.
// ─────────────────────────────────────────────────────────────────────────────

const CSS = `
#tile-info { position:absolute; left:12px; bottom:12px; width:280px; max-width:calc(100vw - 24px); display:none; z-index:21; pointer-events:auto;
  background:var(--c-surface, rgba(20,30,48,.9)); border:1px solid var(--c-border, rgba(100,160,220,.22)); border-radius:10px; color:var(--c-text, #dce8f5);
  font:13px/1.45 var(--font-ui, system-ui, sans-serif); backdrop-filter:blur(6px); }
#tile-info.on { display:block; }
#tile-info header { display:flex; align-items:baseline; gap:8px; padding:8px 12px; border-bottom:1px solid var(--c-border, rgba(100,160,220,.22)); }
#tile-info header b { flex:1; font-weight:600; text-transform:capitalize; }
#tile-info header small, #tile-info .dim { color:var(--c-text-dim, rgba(180,210,240,.6)); font-size:11px; }
#tile-info header span.x { cursor:pointer; padding:0 4px; }
#tile-info dl { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; margin:0; padding:8px 12px; }
#tile-info dt { color:var(--c-text-dim, rgba(180,210,240,.6)); }
#tile-info dd { margin:0; }
#tile-info .ok { color:#8fd98f; } #tile-info .bad { color:#f0a0a0; }
`;

export class TileInfo {

    constructor () {
        const style = document.createElement( 'style' ); style.textContent = CSS; document.head.appendChild( style );
        const el = this.el = document.createElement( 'div' ); el.id = 'tile-info';
        document.body.appendChild( el );
        window.addEventListener( 'city-tile', ( e ) => this.show( e.detail ) );
        window.addEventListener( 'keydown', ( e ) => { if ( e.key === 'Escape' ) this.hide(); } );
    }

    hide () { this.el.classList.remove( 'on' ); }

    show ( t ) {
        const rows = [];
        const add = ( k, v, cls ) => rows.push( `<dt>${ k }</dt><dd${ cls ? ` class="${ cls }"` : '' }>${ v }</dd>` );
        add( 'tile', `(${ t.x }, ${ t.y }) · id ${ t.tile }` );
        if ( t.zone ) {
            const z = t.zone;
            if ( z.size ) add( 'zone', `${ z.kind } ${ z.size }x${ z.size } at (${ z.x }, ${ z.y })` );
            if ( z.level !== undefined ) add( 'level', z.level === 0 ? 'empty, waiting to grow' : `${ z.level }` );
            if ( z.residents !== undefined ) add( 'residents', z.residents );
            if ( z.businesses !== undefined ) add( 'businesses', `${ z.businesses } / 5` );
            if ( z.factories !== undefined ) add( 'factories', `${ z.factories } / 4` );
            add( 'power', z.powered ? 'connected' : 'NO POWER', z.powered ? 'ok' : 'bad' );
        } else if ( t.tile >= 64 ) {
            add( 'power', t.powered ? 'connected' : 'none', t.powered ? 'ok' : '' );
        }
        add( 'land value', t.landValue );
        add( 'density', t.density );
        add( 'crime', t.crime, t.crime > 100 ? 'bad' : '' );
        add( 'pollution', t.pollution, t.pollution > 100 ? 'bad' : '' );
        add( 'traffic', t.traffic, t.traffic > 100 ? 'bad' : '' );
        add( 'growth', t.growth > 0 ? '+' + t.growth : t.growth, t.growth < 0 ? 'bad' : t.growth > 0 ? 'ok' : '' );
        this.el.innerHTML = `<header><b>${ t.name }</b><small>${ ( t.info || [] ).join( ' · ' ) }</small><span class="x" title="close (Esc)">✕</span></header><dl>${ rows.join( '' ) }</dl>`;
        this.el.querySelector( '.x' ).onclick = () => this.hide();
        this.el.classList.add( 'on' );
    }

}
