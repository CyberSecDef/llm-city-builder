// ── Sim ──────────────────────────────────────────────────────────────────────
//  Runs the micropolis simulation headless in Node using CityGame's
//  direct-call mode (the same path the browser uses when AppState.isWorker is
//  false). Messages the sim would postMessage() to the main thread are emitted
//  as 'message' events with the exact same { tell: ... } shape.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import { CityGame } from '../src/micro/CityGame.js';

export class Sim extends EventEmitter {

    constructor ( timestep = 30 ) {

        super();

        this.started   = false;   // PLAYMAP has been sent
        this.mapSize   = null;
        this.island    = false;
        this.tilesData = null;    // live Float32Array owned by the sim (mutated in place)
        this.powerData = null;
        this.infos     = [];
        this.speed     = 2;

        CityGame.message( { data: { tell: 'INIT', timestep, returnMessage: ( e ) => this._onMessage( e.data ) } } );

    }

    // Send a main→worker message.
    post ( msg ) {
        if ( msg.tell === 'PLAYMAP' ) this.started = true;
        if ( msg.tell === 'SPEED' )   this.speed = msg.n;
        CityGame.message( { data: msg } );
    }

    // Convenience: new random map + start playing.
    newGame ( mapSize = [ 128, 128 ] ) {
        this.post( { tell: 'NEWMAP', mapSize } );
        this.post( { tell: 'PLAYMAP' } );
    }

    _onMessage ( d ) {

        switch ( d.tell ) {
            case 'NEWMAP':
            case 'FULLREBUILD':
                this.mapSize   = d.mapSize;
                this.island    = d.island;
                this.tilesData = d.tilesData;
                break;
            case 'RUN':
                this.tilesData = d.tilesData;
                this.powerData = d.powerData;
                this.infos     = d.infos;
                break;
        }

        this.emit( 'message', d );

    }

}
