// ── GameApi ──────────────────────────────────────────────────────────────────
//  The tool surface an LLM plays through. Driver-agnostic: the MCP server,
//  the Anthropic API driver and the Codex driver all call these same methods.
//  Every call returns a plain object (JSON-safe) and emits an 'event' with
//  what happened, so the relay can show viewers what the agent is doing.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import { CityGame } from '../src/micro/CityGame.js';
import { Tile } from '../src/micro/Tile.js';

const RESULT_TEXT = { 0: 'ok', 1: 'failed (off map / not buildable here)', 2: 'not enough money', 3: 'needs bulldozing first' };

// Tool → footprint. (x,y) in the API is the TOP-LEFT tile; the sim's click
// point is always top-left + (1,1).
export const TOOLS = {
    residential: { size: 3, cost: 100 },  commercial: { size: 3, cost: 100 },  industrial: { size: 3, cost: 100 },
    police:      { size: 3, cost: 500 },  fire:       { size: 3, cost: 500 },  hospital:   { size: 3, cost: 500 },
    school:      { size: 3, cost: 500 },
    coal:        { size: 4, cost: 3000 }, nuclear:    { size: 4, cost: 5000 }, port:       { size: 4, cost: 3000 },
    stadium:     { size: 4, cost: 5000 }, airport:    { size: 6, cost: 10000 },
    park:        { size: 1, cost: 10 },
    road:        { size: 1, cost: 10 },   rail:       { size: 1, cost: 20 },   wire:       { size: 1, cost: 5 },
};
export const LINE_TOOLS = [ 'road', 'rail', 'wire' ];

// One character per tile for get_map. Order matters: first match wins.
export const LEGEND = [
    [ '~', 'water' ], [ 'T', 'trees' ], [ '.', 'empty land' ], [ ':', 'rubble' ], [ 'F', 'fire' ], [ 'X', 'radioactive' ],
    [ '#', 'road' ], [ '=', 'rail' ], [ '-', 'power line' ],
    [ 'r', 'residential zone' ], [ 'c', 'commercial zone' ], [ 'i', 'industrial zone' ],
    [ 'H', 'hospital' ], [ 'S', 'school' ], [ 'P', 'police' ], [ 'W', 'fire station' ],
    [ 'E', 'power plant' ], [ 'D', 'stadium' ], [ 'O', 'seaport' ], [ 'A', 'airport' ], [ 'p', 'park' ],
    [ '?', 'other' ],
];

export function tileChar ( v ) {
    const t = v & 0x3FF;
    if ( t === Tile.DIRT ) return '.';
    if ( t <= Tile.WATER_HIGH ) return '~';
    if ( t <= Tile.WOODS5 ) return 'T';
    if ( t <= Tile.LASTRUBBLE ) return ':';
    if ( t <= Tile.LASTFLOOD ) return '~';
    if ( t === Tile.RADTILE ) return 'X';
    if ( t <= Tile.LASTFIRE ) return 'F';
    if ( t <= Tile.LASTROAD ) return '#';
    if ( t <= Tile.LASTPOWER ) return '-';
    if ( t <= Tile.LASTRAIL ) return '=';
    if ( t === Tile.ROADVPOWERH ) return '#';
    if ( t < Tile.HOSPITALBASE ) return 'r';
    if ( t < Tile.CHURCHBASE ) return 'H';
    if ( t < Tile.COMBASE ) return 'S';
    if ( t < Tile.INDBASE ) return 'c';
    if ( t < Tile.PORTBASE ) return 'i';
    if ( t < Tile.AIRPORTBASE ) return 'O';
    if ( t < Tile.COALBASE ) return 'A';
    if ( t < Tile.FIRESTBASE ) return 'E';
    if ( t < Tile.POLICESTBASE ) return 'W';
    if ( t < Tile.STADIUMBASE ) return 'P';
    if ( t < Tile.NUCLEARBASE ) return 'D';
    if ( t <= Tile.LASTZONE ) return 'E';
    if ( t === Tile.FOUNTAIN ) return 'p';
    if ( t >= Tile.HBRDG0 && t <= Tile.HBRDG3 ) return '#';
    if ( t >= Tile.VBRDG0 && t <= Tile.VBRDG3 ) return '#';
    if ( t >= Tile.RADAR0 && t <= Tile.RADAR7 ) return 'A';
    if ( t >= Tile.SMOKEBASE && t < Tile.FOOTBALLGAME1 ) return t >= Tile.COALSMOKE1 ? 'E' : 'i';
    if ( t >= Tile.FOOTBALLGAME1 && t < Tile.VBRDG0 ) return 'D';
    if ( t >= Tile.NUKESWIRL1 && t <= Tile.NUKESWIRL4 ) return 'E';
    if ( t >= Tile.CHURCH1BASE ) return 'S';
    return '?';
}

// Downsample priority: what a block "is" when it holds mixed tiles.
const PRIORITY = 'EAODWPHSrci#=-XF:~Tp.?';   // water before trees: a block with any water is not a build site

export class GameApi extends EventEmitter {

    constructor ( sim ) {
        super();
        this.sim = sim;
        this.log = [];               // recent events, for late-joining viewers
        this.inbox = [];             // viewer messages waiting to be shown to the agent (piggyback on the next tool result)
        this._monthWaiters = [];
        this._lastDate = null;
        // Let building tools clear trees/rubble themselves (+$1/tile) like the
        // classic auto-bulldoze option; one less thing for the agent to sequence.
        // gameTools are (re)created on every new map.
        const autoDoze = () => { for ( const t of Object.values( this.game?.gameTools || {} ) ) t.setAutoBulldoze?.( true ); };
        autoDoze();
        sim.on( 'message', ( d ) => {
            if ( d.tell === 'NEWMAP' || d.tell === 'FULLREBUILD' ) autoDoze();
            if ( d.tell !== 'RUN' ) return;
            const date = d.infos[ 0 ];
            if ( date !== this._lastDate ) {
                this._lastDate = date;
                for ( const w of this._monthWaiters ) w.left--;
                const done = this._monthWaiters.filter( w => w.left <= 0 );
                this._monthWaiters = this._monthWaiters.filter( w => w.left > 0 );
                done.forEach( w => w.resolve() );
            }
        } );
    }

    get game () { return CityGame.game; }
    get map ()  { return this.game.map; }

    // ── read ────────────────────────────────────────────────────────────────

    get_state () {
        const g = this.game, i = this.sim.infos, b = g.getData( 'budget' );
        const counts = this._countZones();
        return this._ok( 'get_state', {
            date: i[ 0 ], cityClass: i[ 1 ], score: i[ 2 ], population: i[ 3 ], funds: i[ 4 ],
            demand: { residential: i[ 5 ], commercial: i[ 6 ], industrial: i[ 7 ] },
            message: i[ 8 ] || '', crime: i[ 10 ], pollution: i[ 11 ], traffic: i[ 12 ],
            approval: i[ 13 ], education: i[ 14 ], health: i[ 15 ], happiness: i[ 16 ],
            speed: this.sim.speed, mapSize: this.sim.mapSize,
            taxes: { residential: b.resTaxRate, commercial: b.comTaxRate, industrial: b.indTaxRate },
            funding: { road: b.roadRate, fire: b.fireRate, police: b.policeRate },
            bondDebt: b.bondDebt,
            zones: counts,
        } );
    }

    get_evaluation () {
        const e = this.game.getData( 'eval' );
        return this._ok( 'get_evaluation', {
            approval: e[ 0 ], problems: e[ 1 ].split( '<br>' ).filter( Boolean ),
            crime: e[ 2 ], pollution: e[ 3 ], traffic: e[ 4 ], education: e[ 5 ], health: e[ 6 ],
            happiness: e[ 7 ], unemployment: e[ 8 ], season: e[ 9 ],
            coverage: { police: e[ 10 ], fire: e[ 11 ], water: e[ 13 ], education: e[ 17 ] }, parks: e[ 12 ],
        } );
    }

    // ASCII map. Whole map downsampled by `scale` (default 4 → 32x32 for a
    // 128 map), or a full-resolution window with x,y,w,h (max 64x64).
    get_map ( { x, y, w, h, scale } = {} ) {
        const [ W, H ] = this.sim.mapSize;
        const tiles = this.sim.tilesData;
        let out, x0, y0, x1, y1, s;
        if ( x !== undefined && y !== undefined ) {
            s = 1;
            w = Math.min( w ?? 32, 64 ); h = Math.min( h ?? 32, 64 );
            x0 = clamp( x, 0, W - 1 ); y0 = clamp( y, 0, H - 1 );
            x1 = Math.min( x0 + w, W ); y1 = Math.min( y0 + h, H );
        } else {
            s = scale ?? 4; x0 = 0; y0 = 0; x1 = W; y1 = H;
        }
        const rows = [];
        const width = Math.ceil( ( x1 - x0 ) / s );
        for ( let ty = y0; ty < y1; ty += s ) {
            let row = '';
            for ( let tx = x0; tx < x1; tx += s ) {
                if ( s === 1 ) { row += tileChar( tiles[ tx + ty * W ] ); continue; }
                let best = '.', bestP = PRIORITY.length;
                for ( let dy = 0; dy < s && ty + dy < y1; dy++ ) for ( let dx = 0; dx < s && tx + dx < x1; dx++ ) {
                    const c = tileChar( tiles[ tx + dx + ( ty + dy ) * W ] );
                    const p = PRIORITY.indexOf( c );
                    if ( p < bestP ) { bestP = p; best = c; }
                }
                row += best;
            }
            rows.push( String( ty ).padStart( 3 ) + ' ' + row );
        }
        const header = '    ' + Array.from( { length: width }, ( _, k ) => ( ( x0 + k * s ) % 10 === 0 ) ? String( ( x0 + k * s ) / 10 % 10 ) : ' ' ).join( '' );
        const text = [ header, ...rows ].join( '\n' );
        out = {
            region: { x: x0, y: y0, w: x1 - x0, h: y1 - y0, scale: s },
            note: s > 1 ? `each character covers a ${ s }x${ s } tile block; column header shows x/10 at every 10th tile` : 'one character per tile; header shows x/10 at every 10th tile',
            legend: Object.fromEntries( LEGEND ),
            map: text,
        };
        return this._ok( 'get_map', out, { x: x0, y: y0, w: x1 - x0, h: y1 - y0, scale: s } );
    }

    query ( { x, y } ) {
        const g = this.game;
        if ( !this.map.testBounds( x, y ) ) return this._fail( 'query', { x, y }, 'off map' );
        g.tool( 'query' );
        let txt = '';
        const orig = CityGame.post;
        CityGame.post = ( m ) => { if ( m.tell === 'QUERY' ) txt = m.queryTxt; else orig( m ); };
        try { g.mapClick( x, y, true ); } finally { CityGame.post = orig; g.tool( 'none' ); }
        const v = this.map.getTileValue( x, y );
        const info = txt.replace( /<br>/g, '\n' ).trim();
        return this._ok( 'query', { x, y, tile: tileChar( v ), powered: !!( this.map.getTile( x, y ).getRawValue() & Tile.POWERBIT ), info }, { x, y } );
    }

    // ── act ─────────────────────────────────────────────────────────────────

    build ( { tool, x, y } ) {
        const spec = TOOLS[ tool ];
        if ( !spec ) return this._fail( 'build', { tool, x, y }, `unknown tool "${ tool }"; valid: ${ Object.keys( TOOLS ).join( ', ' ) }` );
        const before = this._funds();
        const r = this._click( tool, x + ( spec.size > 1 ? 1 : 0 ), y + ( spec.size > 1 ? 1 : 0 ) );
        const cost = before - this._funds();
        if ( r !== 0 ) return this._fail( 'build', { tool, x, y }, r === 3 ? this._blockers( x, y, spec.size ) : RESULT_TEXT[ r ] );
        return this._ok( 'build', { tool, x, y, size: spec.size, cost, funds: this._funds() }, { tool, x, y } );
    }

    // Straight or L-shaped line (horizontal leg first, then vertical).
    build_line ( { tool, x0, y0, x1, y1 } ) {
        if ( !LINE_TOOLS.includes( tool ) ) return this._fail( 'build_line', { tool }, `build_line only takes ${ LINE_TOOLS.join( '/' ) }` );
        const before = this._funds();
        let placed = 0, failed = 0, lastErr = null;
        const pts = [];
        const sx = Math.sign( x1 - x0 ) || 1, sy = Math.sign( y1 - y0 ) || 1;
        for ( let x = x0; x !== x1 + sx; x += sx ) pts.push( [ x, y0 ] );
        for ( let y = y0 + sy; y !== y1 + sy; y += sy ) pts.push( [ x1, y ] );
        this.game.tool( tool );
        for ( const [ x, y ] of pts ) {
            const r = this._clickRaw( x, y );
            if ( r === 0 ) placed++; else { failed++; lastErr = RESULT_TEXT[ r ]; if ( r === 2 ) break; }
        }
        this.game.tool( 'none' );
        const cost = before - this._funds();
        const args = { tool, x0, y0, x1, y1 };
        if ( placed === 0 ) return this._fail( 'build_line', args, lastErr || 'nothing placed' );
        return this._ok( 'build_line', { placed, failed, lastError: lastErr, cost, funds: this._funds() }, args );
    }

    bulldoze ( { x, y, w = 1, h = 1 } ) {
        w = Math.min( w, 16 ); h = Math.min( h, 16 );
        const before = this._funds();
        let cleared = 0;
        this.game.tool( 'bulldozer' );
        for ( let ty = y; ty < y + h; ty++ ) for ( let tx = x; tx < x + w; tx++ ) if ( this._clickRaw( tx, ty ) === 0 ) cleared++;
        this.game.tool( 'none' );
        return this._ok( 'bulldoze', { x, y, w, h, cleared, cost: before - this._funds(), funds: this._funds() }, { x, y, w, h } );
    }

    set_speed ( { speed } ) {
        if ( ![ 0, 1, 2, 3 ].includes( speed ) ) return this._fail( 'set_speed', { speed }, 'speed must be 0 (pause), 1, 2 or 3' );
        this.sim.post( { tell: 'SPEED', n: speed } );
        return this._ok( 'set_speed', { speed }, { speed } );
    }

    set_budget ( args ) {
        const b = this.game.getData( 'budget' );
        const pick = ( k, cur, lo, hi ) => args[ k ] === undefined ? cur : clamp( Math.round( args[ k ] ), lo, hi );
        const data = [
            pick( 'residentialTax', b.resTaxRate, 0, 20 ), pick( 'commercialTax', b.comTaxRate, 0, 20 ), pick( 'industrialTax', b.indTaxRate, 0, 20 ),
            pick( 'roadFunding', b.roadRate, 0, 100 ), pick( 'fireFunding', b.fireRate, 0, 100 ), pick( 'policeFunding', b.policeRate, 0, 100 ),
        ];
        this.sim.post( { tell: 'NEWBUDGET', budgetData: data } );
        const n = this.game.getData( 'budget' );
        return this._ok( 'set_budget', {
            taxes: { residential: n.resTaxRate, commercial: n.comTaxRate, industrial: n.indTaxRate },
            funding: { road: n.roadRate, fire: n.fireRate, police: n.policeRate },
        }, args );
    }

    say ( { text } ) {
        return this._ok( 'say', { said: true }, { text } );
    }

    // Resolve after the sim date has advanced `months` months (capped).
    async wait ( { months = 1 } = {} ) {
        months = clamp( Math.round( months ), 1, 24 );
        if ( this.sim.speed === 0 ) return this._fail( 'wait', { months }, 'the game is paused; call set_speed first' );
        const t0 = Date.now();
        await new Promise( ( resolve ) => this._monthWaiters.push( { left: months, resolve } ) );
        const s = this.get_state().result;
        return this._ok( 'wait', { waitedMs: Date.now() - t0, date: s.date, funds: s.funds, population: s.population, message: s.message }, { months } );
    }

    // ── internals ───────────────────────────────────────────────────────────

    _funds () { return this.game.simulation.budget.totalFunds; }

    _click ( tool, x, y ) {
        this.game.tool( tool );
        const r = this._clickRaw( x, y );
        this.game.tool( 'none' );
        return r;
    }

    _clickRaw ( x, y ) {
        if ( !this.map.testBounds( x, y ) ) return 1;
        this.game.mapClick( x, y, false );
        return this.game.currentTool.result;
    }

    // Explain why a footprint isn't buildable.
    _blockers ( x, y, size ) {
        const c = { water: 0, 'existing structure': 0, 'off map': 0 };
        for ( let ty = y; ty < y + size; ty++ ) for ( let tx = x; tx < x + size; tx++ ) {
            if ( !this.map.testBounds( tx, ty ) ) { c[ 'off map' ]++; continue; }
            const ch = tileChar( this.map.getTileValue( tx, ty ) );
            if ( ch === '~' ) c.water++; else if ( ch !== '.' && ch !== 'T' && ch !== ':' ) c[ 'existing structure' ]++;
        }
        const parts = Object.entries( c ).filter( ( [ , n ] ) => n ).map( ( [ k, n ] ) => `${ n } ${ k }` );
        return `${ size }x${ size } footprint at (${ x },${ y }) is blocked: ${ parts.join( ', ' ) || 'unknown' }. Water can't be built on; structures need bulldoze first.`;
    }

    _countZones () {
        // sim.tilesData is the render layer (values only); flags live in map.data.
        const data = this.map.data;
        const c = { residential: 0, commercial: 0, industrial: 0, unpowered: 0, roads: 0 };
        for ( let i = 0; i < data.length; i++ ) {
            const v = data[ i ].getRawValue(), k = v & Tile.BIT_MASK;
            if ( k >= Tile.ROADBASE && k <= Tile.LASTROAD ) { c.roads++; continue; }
            if ( !( v & Tile.ZONEBIT ) ) continue;
            if ( k >= Tile.RESBASE && k < Tile.HOSPITALBASE ) c.residential++;
            else if ( k >= Tile.COMBASE && k < Tile.INDBASE ) c.commercial++;
            else if ( k >= Tile.INDBASE && k < Tile.PORTBASE ) c.industrial++;
            else continue;
            if ( !( v & Tile.POWERBIT ) ) c.unpowered++;
        }
        return c;
    }

    _ok ( name, result, args ) {
        const ev = { type: 'tool', name, args, ok: true, result, at: Date.now() };
        this._emit( ev );
        return { ok: true, result: this._withInbox( result ) };
    }

    _fail ( name, args, error ) {
        const ev = { type: 'tool', name, args, ok: false, error, at: Date.now() };
        this._emit( ev );
        return { ok: false, error: this._withInbox( error ) };
    }

    // Deliver waiting viewer messages inside whatever result goes back next,
    // so the agent sees them mid-turn without the driver having to interrupt.
    _withInbox ( r ) {
        if ( !this.inbox.length ) return r;
        const msgs = this.inbox.splice( 0 ).map( ( m ) => `Viewer ${ m.name }: ${ m.text }` );
        if ( typeof r === 'string' ) return r + '\n\nNEW VIEWER MESSAGES:\n' + msgs.join( '\n' );
        return { ...r, viewerMessages: msgs };
    }

    _emit ( ev ) {
        // Reads are chatty and uninteresting to viewers; only actions hit the log.
        if ( [ 'get_state', 'get_map', 'get_evaluation', 'query' ].includes( ev.name ) ) { this.emit( 'event', { ...ev, quiet: true } ); return; }
        this.log.push( ev );
        if ( this.log.length > 200 ) this.log.shift();
        this.emit( 'event', ev );
    }

}

function clamp ( v, lo, hi ) { return Math.max( lo, Math.min( hi, v ) ); }
