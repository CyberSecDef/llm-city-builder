// ── Claude Code driver ───────────────────────────────────────────────────────
//  Runs `claude -p` as a long-lived child with stream-json on both stdin and
//  stdout, so the whole game is one conversation. The city tools reach it
//  through our MCP server; every built-in tool is switched off.
//
//  Events: 'text' {text}, 'tool_use' {name,input}, 'usage' {...}, 'turn' {costUsd,...},
//          'status' {text}, 'exit' {code}
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import fs from 'node:fs';

export class ClaudeCodeDriver extends EventEmitter {

    constructor ( { mcpUrl, systemPrompt, model, maxBudgetUsd, cwd, logFile } ) {
        super();
        this.mcpUrl = mcpUrl; this.systemPrompt = systemPrompt; this.model = model;
        this.maxBudgetUsd = maxBudgetUsd; this.cwd = cwd; this.logFile = logFile;
        this.proc = null; this.busy = false; this.sessionId = null;
    }

    get name () { return 'claude-code' + ( this.model ? `:${ this.model }` : '' ); }

    serialize () { return { sessionId: this.sessionId }; }
    restore ( s ) { if ( s?.sessionId ) this.resumeId = s.sessionId; }

    start () {
        const mcp = JSON.stringify( { mcpServers: { city: { type: 'http', url: this.mcpUrl } } } );
        const args = [
            '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages',
            '--tools', '', '--restricted', '--setting-sources', '',
            '--strict-mcp-config', '--mcp-config', mcp, '--allowedTools', 'mcp__city__*',
            '--system-prompt', this.systemPrompt,
        ];
        if ( this.model ) args.push( '--model', this.model );
        if ( this.resumeId ) args.push( '--resume', this.resumeId );
        if ( this.maxBudgetUsd ) args.push( '--max-budget-usd', String( this.maxBudgetUsd ) );

        this.proc = spawn( 'claude', args, { cwd: this.cwd, stdio: [ 'pipe', 'pipe', 'pipe' ], env: { ...process.env, CLAUDECODE: undefined } } );
        // Never leave a mayor playing against a server that's gone.
        const child = this.proc;
        const kill = () => { try { child.kill( 'SIGKILL' ); } catch {} };
        process.once( 'exit', kill );
        child.once( 'exit', () => process.off( 'exit', kill ) );

        this.proc.stderr.on( 'data', ( d ) => this.emit( 'status', { text: `claude: ${ String( d ).trim() }` } ) );
        this.proc.on( 'exit', ( code ) => { this.busy = false; this.emit( 'exit', { code } ); } );

        const rl = readline.createInterface( { input: this.proc.stdout } );
        rl.on( 'line', ( line ) => { if ( line.trim() ) this._onLine( line ); } );
        this.emit( 'status', { text: `started ${ this.name }` } );
    }

    // Send one user turn. Resolves when the turn's result event arrives.
    send ( text ) {
        if ( !this.proc ) throw new Error( 'driver not started' );
        if ( this.busy ) throw new Error( 'driver busy' );
        this.busy = true;
        const msg = { type: 'user', message: { role: 'user', content: [ { type: 'text', text } ] } };
        this.proc.stdin.write( JSON.stringify( msg ) + '\n' );
        return new Promise( ( resolve ) => { this._turnDone = resolve; } );
    }

    stop () {
        const p = this.proc;
        if ( !p ) return;
        this.proc = null;
        try { p.stdin.end(); } catch {}
        const t = setTimeout( () => { try { p.kill( 'SIGKILL' ); } catch {} }, 3000 );
        p.once( 'exit', () => clearTimeout( t ) );
    }

    _onLine ( line ) {
        if ( this.logFile ) fs.appendFile( this.logFile, line + '\n', () => {} );
        let ev; try { ev = JSON.parse( line ); } catch { return; }
        switch ( ev.type ) {
            case 'system':
                if ( ev.subtype === 'init' ) { this.sessionId = ev.session_id; this.emit( 'model', { model: ev.model } ); this.emit( 'status', { text: `session ${ ev.session_id } model ${ ev.model }` } ); }
                break;
            case 'assistant': {
                const m = ev.message || {};
                for ( const c of m.content || [] ) {
                    if ( c.type === 'text' && c.text.trim() ) this.emit( 'text', { text: c.text } );
                    if ( c.type === 'tool_use' ) this.emit( 'tool_use', { name: c.name.replace( /^mcp__city__/, '' ), input: c.input } );
                }
                // usage here is a per-block snapshot with a placeholder
                // output count; the real numbers come from stream_event below.
                break;
            }
            case 'stream_event': {
                const e = ev.event || {};
                if ( e.type === 'message_start' ) {
                    const u = e.message?.usage || {};
                    this._step = { input: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, output: 0 };
                } else if ( e.type === 'message_delta' && this._step ) {
                    this._step.output = e.usage?.output_tokens || 0;
                    this.emit( 'usage', this._step ); this._step = null;
                }
                break;
            }
            case 'rate_limit_event': {
                const w = ev.rate_limit_info?.unifiedWindows;
                if ( w ) this.emit( 'limits', { fiveHour: w.five_hour?.utilization, sevenDay: w.seven_day?.utilization } );
                break;
            }
            case 'result':
                this.busy = false;
                this.emit( 'turn', { costUsd: ev.total_cost_usd || 0, cumulative: true, durationMs: ev.duration_ms || 0, subtype: ev.subtype, error: ev.is_error ? ( ev.result || ev.subtype ) : null } );
                this._turnDone?.( ev ); this._turnDone = null;
                break;
        }
    }

}
