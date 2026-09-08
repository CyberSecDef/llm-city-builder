// ── AgentHost ────────────────────────────────────────────────────────────────
//  Runs the play loop: nudge the driver, let it act through GameApi, collect
//  narration/tool calls into a transcript, feed viewer chat back in, and keep
//  the ledger. Driver-agnostic: anything with start()/send()/stop() and the
//  driver events works.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import { Ledger } from './ledger.js';

const TRANSCRIPT_MAX = 300;

export const SYSTEM_PROMPT = `You are the mayor of a brand-new city in a Micropolis/SimCity-style game, playing live in front of an audience. You act only through the city tools (build, build_line, bulldoze, set_budget, set_speed, wait, get_state, get_map, get_evaluation, query, say).

How the game works
- Coordinates: x is the column (left→right), y is the row (top→bottom). Tiles are 1x1. build() places the TOP-LEFT corner.
- Residential (r), commercial (c) and industrial (i) zones are 3x3 and only develop when powered and within ~3 tiles of a road. Power: build a coal plant (4x4, $3000) and connect it with power lines (build_line wire) to the zone edge; adjacent zones pass power along, so a contiguous block of zones only needs one wire touching it.
- Keep industry a few tiles away from residential (pollution). Fire/police stations cover a radius; they matter once the city grows. Roads cost $10/tile plus yearly upkeep.
- RCI demand from get_state says what citizens want more of. Funds only grow from taxes as population grows; you start with $10000, so a sensible opening is one power plant, one road, a dozen zones, then wait.
- wait(months) lets the sim run; a month is roughly 2 s at speed 2. Use it after each batch of changes so you can see what happened.

How to behave
- Start every turn with get_state; get_map (whole map, then a full-res window of your build area) before placing things — water blocks building.
- Narrate through say(): announce what you are about to do and why in one or two sentences, and react to results. Viewers only see say() and your tool calls, so use it generously but don't repeat yourself.
- Messages from viewers arrive as "Viewer <name>: …", either in the nudge or as a viewerMessages field inside a tool result. Answer them with say() promptly, and take reasonable suggestions.
- Each turn: a few actions, a wait, a short say(). Then end your turn with a one-line summary; you'll be nudged to continue. Don't ask permission — you're the mayor.`;

export class AgentHost extends EventEmitter {

    constructor ( api, driver ) {
        super();
        this.api = api; this.driver = driver;
        this.ledger = new Ledger();
        this.transcript = [];
        this.running = false; this.paused = false;
        this._wake = null;

        api.on( 'event', ( ev ) => {
            if ( ev.quiet ) return;
            if ( ev.name === 'say' ) this._add( { kind: 'say', text: ev.args.text } );
            else this._add( { kind: 'tool', name: ev.name, args: ev.args, ok: ev.ok, result: ev.ok ? summarise( ev.result ) : ev.error } );
        } );
        driver.on( 'text',   ( e ) => this._add( { kind: 'text', text: e.text } ) );
        driver.on( 'status', ( e ) => this._add( { kind: 'status', text: e.text } ) );
        driver.on( 'model',  ( m ) => this.ledger.setModel( m.model ) );
        driver.on( 'usage',  ( u ) => this.ledger.addStep( u ) );
        driver.on( 'limits', ( l ) => { this.limits = l; this.emit( 'ledger', this.ledger.snapshot() ); } );
        driver.on( 'turn',   ( t ) => { this.ledger.endTurn( t ); if ( t.error ) this._add( { kind: 'error', text: String( t.error ) } ); } );
        driver.on( 'exit',   ( e ) => { this._add( { kind: 'status', text: `driver exited (${ e.code })` } ); this.running = false; } );
        this.ledger.on( 'update', ( s ) => this.emit( 'ledger', s ) );
    }

    snapshot () {
        return { entries: this.transcript.slice( -100 ), ledger: this.ledger.snapshot(), limits: this.limits || null, driver: this.driver.name, running: this.running, paused: this.paused };
    }

    async start () {
        if ( this.running ) return;
        this.running = true;
        this.driver.start();
        let first = true;
        while ( this.running ) {
            if ( this.paused ) { await this._sleep( 1000 ); continue; }
            const prompt = first ? this._kickoff() : this._continue();
            first = false;
            this.ledger.beginTurn();
            try { await this.driver.send( prompt ); }
            catch ( err ) { this._add( { kind: 'error', text: err.message } ); await this._sleep( 5000 ); }
            // Breathe between turns: viewers get a chance to talk, the sim to move.
            if ( this.api.inbox.length === 0 ) await this._sleep( 4000 );
        }
    }

    stop () { this.running = false; this.driver.stop(); }
    pause () { this.paused = true; this._add( { kind: 'status', text: 'paused' } ); }
    resume () { this.paused = false; this._add( { kind: 'status', text: 'resumed' } ); this._wake?.(); }

    chat ( name, text ) {
        this.api.inbox.push( { name, text } );
        this._add( { kind: 'user', name, text } );
        this._wake?.();
    }

    _kickoff () {
        return `A new ${ this.api.sim.mapSize.join( 'x' ) } map has just been generated and the clock is running. Introduce yourself to the viewers with say(), look at the map, and found the city.`;
    }

    _continue () {
        const chat = this.api.inbox.splice( 0 );
        const lines = chat.map( ( c ) => `Viewer ${ c.name }: ${ c.text }` );
        return ( lines.length ? lines.join( '\n' ) + '\n\n' : '' ) + 'Continue playing.';
    }

    _add ( entry ) {
        entry.at = entry.at || Date.now();
        this.transcript.push( entry );
        if ( this.transcript.length > TRANSCRIPT_MAX ) this.transcript.shift();
        this.emit( 'entry', entry );
    }

    _sleep ( ms ) {
        return new Promise( ( resolve ) => {
            const t = setTimeout( () => { this._wake = null; resolve(); }, ms );
            this._wake = () => { clearTimeout( t ); this._wake = null; resolve(); };
        } );
    }

}

// Keep tool results in the transcript short; the full thing went to the model.
function summarise ( r ) {
    if ( r === undefined || r === null ) return '';
    if ( typeof r === 'string' ) return r.length > 120 ? r.slice( 0, 117 ) + '…' : r;
    const { map, legend, note, ...rest } = r;
    const s = JSON.stringify( rest );
    return s.length > 160 ? s.slice( 0, 157 ) + '…' : s;
}
