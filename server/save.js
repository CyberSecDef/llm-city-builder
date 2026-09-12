// ── Save file ────────────────────────────────────────────────────────────────
//  One JSON file per game holding everything needed to carry on as if the
//  server never stopped: the micropolis save blob, the agent's transcript,
//  ledger and unread viewer messages, and whatever the driver needs to
//  resume its conversation (API history, Codex thread, Claude Code session).
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;

export class GameSave {

    constructor ( file ) { this.file = file; this._busy = false; }

    exists () { return fs.existsSync( this.file ); }

    read () {
        const s = JSON.parse( fs.readFileSync( this.file, 'utf8' ) );
        if ( s.version !== VERSION ) throw new Error( `save version ${ s.version } not supported` );
        return s;
    }

    // Atomic: write to a temp file, then rename over the old save.
    async write ( { sim, host, agentSpec } ) {
        if ( this._busy ) return false;
        this._busy = true;
        try {
            const data = {
                version: VERSION, savedAt: new Date().toISOString(), agentSpec: agentSpec || null,
                city: await sim.save(),
                agent: host ? host.serialize() : null,
            };
            fs.mkdirSync( path.dirname( this.file ), { recursive: true } );
            const tmp = this.file + '.tmp';
            fs.writeFileSync( tmp, JSON.stringify( data ) );
            fs.renameSync( tmp, this.file );
            return true;
        } finally { this._busy = false; }
    }

}
