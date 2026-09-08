// ── Relay ────────────────────────────────────────────────────────────────────
//  WebSocket fan-out from the headless Sim to browser viewers.
//
//  Everything the sim emits is forwarded as JSON, except RUN, which is
//  throttled to BROADCAST_HZ and sent as a binary diff frame (see RunCodec).
//  Layer-dirty flags and the power-changed flag are OR-ed across skipped ticks
//  so the renderer never misses a redraw.
//
//  Viewers may send a small whitelist of read-only tells (budget, eval, …).
//  Anything that mutates the city is dropped: only the agent builds.
// ─────────────────────────────────────────────────────────────────────────────

import { WebSocketServer } from 'ws';
import { RunEncoder } from '../src/net/RunCodec.js';

const BROADCAST_HZ = 20;

// Read-only requests a viewer is allowed to relay to the sim.
const VIEWER_TELLS = new Set( [ 'BUDGET', 'EVAL', 'ACHIEVEMENTS', 'HISTORY', 'GETORDINANCES', 'GETINDUSTRYSPEC', 'GETOVERLAY' ] );

export class Relay {

    constructor ( sim, httpServer ) {

        this.sim     = sim;
        this.wss     = new WebSocketServer( { server: httpServer, path: '/ws' } );
        this.encoder = new RunEncoder();

        this._pending    = null;   // latest RUN not yet broadcast
        this._layerAcc   = [];     // OR of layer flags since last broadcast
        this._powerAcc   = false;
        this._lastSentAt = 0;
        this._timer      = null;

        sim.on( 'message', ( d ) => this._onSim( d ) );
        this.wss.on( 'connection', ( ws ) => this._onViewer( ws ) );

    }

    get viewerCount () { return this.wss.clients.size; }

    // Hook up the agent host: its transcript and ledger go to viewers, viewer
    // chat goes to it.
    attachAgent ( host ) {
        this.agent = host;
        host.on( 'entry',  ( entry )  => this._broadcastJSON( { tell: 'AGENT', entry } ) );
        host.on( 'ledger', ( ledger ) => this._broadcastJSON( { tell: 'LEDGER', ledger } ) );
    }

    // ── sim → viewers ───────────────────────────────────────────────────────

    _onSim ( d ) {

        if ( d.tell === 'RUN' ) {
            this._pending = d;
            for ( let i = 0; i < d.layer.length; i++ ) if ( d.layer[ i ] ) this._layerAcc[ i ] = 1;
            if ( d.infos[ 9 ] ) this._powerAcc = true;
            this._scheduleRun();
            return;
        }

        // NEWMAP / FULLREBUILD replace the map; the diff baseline is stale.
        if ( d.tell === 'NEWMAP' || d.tell === 'FULLREBUILD' ) this.encoder.reset();

        // SAVEGAME / LOADGAME are main-thread storage round-trips; the server
        // owns persistence (M4), viewers never see them.
        if ( d.tell === 'SAVEGAME' || d.tell === 'LOADGAME' ) return;

        this._broadcastJSON( d );

    }

    _scheduleRun () {
        if ( this._timer ) return;
        const wait = Math.max( 0, 1000 / BROADCAST_HZ - ( Date.now() - this._lastSentAt ) );
        this._timer = setTimeout( () => { this._timer = null; this._flushRun(); }, wait );
    }

    _flushRun () {

        const d = this._pending;
        if ( !d ) return;
        this._pending = null;
        this._lastSentAt = Date.now();

        if ( this.viewerCount === 0 ) {
            // Nobody listening; keep the accumulators so the next viewer's
            // first diff after its snapshot is still complete.
            return;
        }

        const infos = d.infos.slice();
        infos[ 9 ] = this._powerAcc;
        const meta  = { tell: 'RUN', infos, sprites: d.sprites, layer: this._layerAcc };
        const frame = this.encoder.encode( meta, d.tilesData, d.powerData );

        this._layerAcc = [];
        this._powerAcc = false;

        this._send( frame );

    }

    _broadcastJSON ( d ) {
        this._send( JSON.stringify( toWire( d ) ) );
    }

    // Only viewers that have JOINed (and so hold a full snapshot) get the stream;
    // a diff frame before a full one is undecodable.
    _send ( payload ) {
        for ( const ws of this.wss.clients ) if ( ws.joined && ws.readyState === ws.OPEN ) ws.send( payload );
    }

    // ── viewers → sim ───────────────────────────────────────────────────────

    _onViewer ( ws ) {

        ws.on( 'message', ( raw, isBinary ) => {
            if ( isBinary ) return;
            let msg;
            try { msg = JSON.parse( raw.toString() ); } catch { return; }
            if ( !msg || typeof msg.tell !== 'string' ) return;

            if ( msg.tell === 'JOIN' ) { this._sendSnapshot( ws ); ws.joined = true; this._sendAgentSync( ws ); return; }
            if ( msg.tell === 'CHAT' && this.agent && typeof msg.text === 'string' ) {
                this.agent.chat( String( msg.name || 'viewer' ).slice( 0, 24 ), msg.text.slice( 0, 500 ) );
                return;
            }
            if ( VIEWER_TELLS.has( msg.tell ) ) this.sim.post( msg );
            // everything else is silently dropped
        } );

    }

    // Full current state so a late joiner can paint the map. Reuses the
    // FULLREBUILD shape the browser already understands; cityData is null
    // because the 3D build lists live in each viewer and are rebuilt from tiles.
    _sendSnapshot ( ws ) {

        const sim = this.sim;
        if ( !sim.tilesData ) {
            ws.send( JSON.stringify( { tell: 'WAITING' } ) );
            return;
        }

        ws.send( JSON.stringify( toWire( {
            tell: 'FULLREBUILD', tilesData: sim.tilesData, mapSize: sim.mapSize,
            island: sim.island, cityData: null, isStart: sim.started, speed: sim.speed,
        } ) ) );

        if ( sim.powerData ) {
            const meta  = { tell: 'RUN', infos: sim.infos, sprites: [], layer: [] };
            ws.send( this.encoder.encode( meta, sim.tilesData, sim.powerData, true ) );
        }

    }

    _sendAgentSync ( ws ) {
        if ( !this.agent ) return;
        ws.send( JSON.stringify( { tell: 'AGENT_SYNC', ...this.agent.snapshot() } ) );
    }

}

// Typed arrays don't JSON-serialise as arrays; the only non-RUN messages that
// carry one are NEWMAP/FULLREBUILD (tilesData), and JSON is fine there since
// they are rare.
function toWire ( d ) {
    if ( d.tilesData instanceof Float32Array ) return { ...d, tilesData: Array.from( d.tilesData ) };
    return d;
}
