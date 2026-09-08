// ── RunCodec ────────────────────────────────────────────────────────────────
//  Binary encoding for the per-tick RUN message on the wire.
//
//  The sim posts RUN ~20×/s carrying two Float32Array maps (tiles + power,
//  16 384 entries each at 128×128). Sent as JSON that is ~200 KB per tick;
//  sent as a u16 diff against the previous frame it is usually < 1 KB.
//
//  Frame layout (little-endian):
//    u8   kind        0 = full, 1 = diff
//    u32  jsonLen     JSON of everything that isn't a map
//    u8[] json        { infos, sprites, layer }
//    u32  nTiles      full: u16[nTiles] values
//                     diff: (u16 index, u16 value) × nTiles
//    u32  nPower      same shape as tiles
//
//  Shared by server/relay.js (encode) and src/WorkerBridge.js (decode).
// ─────────────────────────────────────────────────────────────────────────────

const KIND_FULL = 0;
const KIND_DIFF = 1;

const enc = new TextEncoder();
const dec = new TextDecoder();

// Tile values are 16-bit (10 bits of tile id + flag bits); powerData is 0..2.
// Both come out of the sim as Float32Array. Assert rather than silently wrap.
function toU16 ( f32 ) {
    const out = new Uint16Array( f32.length );
    for ( let i = 0; i < f32.length; i++ ) {
        const v = f32[ i ];
        if ( v < 0 || v > 0xFFFF || v !== ( v | 0 ) ) throw new Error( 'RunCodec: value ' + v + ' at ' + i + ' does not fit u16' );
        out[ i ] = v;
    }
    return out;
}

export class RunEncoder {

    constructor () {
        this._lastTiles = null;
        this._lastPower = null;
    }

    // Forget the previous frame; the next encode() will be a full frame.
    reset () {
        this._lastTiles = null;
        this._lastPower = null;
    }

    // meta: { infos, sprites, layer }.  Returns an ArrayBuffer.
    // full=true forces a full frame (new viewer) without touching diff state.
    encode ( meta, tilesF32, powerF32, full = false ) {

        const tiles = toU16( tilesF32 );
        const power = toU16( powerF32 );
        const json  = enc.encode( JSON.stringify( meta ) );

        const canDiff = !full && this._lastTiles && this._lastTiles.length === tiles.length
                                && this._lastPower && this._lastPower.length === power.length;

        let kind, tileBody, powerBody, nTiles, nPower;

        if ( canDiff ) {
            const dt = diff( this._lastTiles, tiles );
            const dp = diff( this._lastPower, power );
            // A diff costs 2 u16 per entry; past half the map a full frame is smaller.
            if ( dt.length / 2 > tiles.length / 2 || dp.length / 2 > power.length / 2 ) {
                kind = KIND_FULL; tileBody = tiles; powerBody = power; nTiles = tiles.length; nPower = power.length;
            } else {
                kind = KIND_DIFF; tileBody = dt; powerBody = dp; nTiles = dt.length / 2; nPower = dp.length / 2;
            }
        } else {
            kind = KIND_FULL; tileBody = tiles; powerBody = power; nTiles = tiles.length; nPower = power.length;
        }

        if ( !full ) {
            // This frame becomes the diff baseline for the next broadcast.
            this._lastTiles = tiles;
            this._lastPower = power;
        }

        const size = 1 + 4 + json.length + 4 + tileBody.byteLength + 4 + powerBody.byteLength;
        const buf  = new ArrayBuffer( size );
        const view = new DataView( buf );
        const u8   = new Uint8Array( buf );
        let o = 0;

        view.setUint8( o, kind ); o += 1;
        view.setUint32( o, json.length, true ); o += 4;
        u8.set( json, o ); o += json.length;
        view.setUint32( o, nTiles, true ); o += 4;
        u8.set( new Uint8Array( tileBody.buffer, tileBody.byteOffset, tileBody.byteLength ), o ); o += tileBody.byteLength;
        view.setUint32( o, nPower, true ); o += 4;
        u8.set( new Uint8Array( powerBody.buffer, powerBody.byteOffset, powerBody.byteLength ), o ); o += powerBody.byteLength;

        return buf;

    }

}

// Returns Uint16Array of (index, value) pairs where b differs from a.
function diff ( a, b ) {
    const pairs = [];
    for ( let i = 0; i < b.length; i++ ) {
        if ( a[ i ] !== b[ i ] ) pairs.push( i, b[ i ] );
    }
    return Uint16Array.from( pairs );
}

export class RunDecoder {

    constructor () {
        this.tiles = null;   // Float32Array, persistent, mutated in place
        this.power = null;
    }

    // buf: ArrayBuffer. Returns { infos, sprites, layer, tilesData, powerData }
    // with tilesData/powerData being the decoder's persistent arrays.
    decode ( buf ) {

        const view = new DataView( buf );
        const u8   = new Uint8Array( buf );
        let o = 0;

        const kind = view.getUint8( o ); o += 1;
        const jsonLen = view.getUint32( o, true ); o += 4;
        const meta = JSON.parse( dec.decode( u8.subarray( o, o + jsonLen ) ) ); o += jsonLen;

        const nTiles = view.getUint32( o, true ); o += 4;
        o = this._apply( kind, u8, o, nTiles, 'tiles' );
        const nPower = view.getUint32( o, true ); o += 4;
        o = this._apply( kind, u8, o, nPower, 'power' );

        meta.tilesData = this.tiles;
        meta.powerData = this.power;
        return meta;

    }

    _apply ( kind, u8, o, n, key ) {

        // Body may not be 2-byte aligned in the frame; copy before viewing as u16.
        const bytes = ( kind === KIND_FULL ) ? n * 2 : n * 4;
        const body  = new Uint16Array( u8.slice( o, o + bytes ).buffer );

        if ( kind === KIND_FULL ) {
            if ( !this[ key ] || this[ key ].length !== n ) this[ key ] = new Float32Array( n );
            const dst = this[ key ];
            for ( let i = 0; i < n; i++ ) dst[ i ] = body[ i ];
        } else {
            if ( !this[ key ] ) throw new Error( 'RunCodec: diff frame before any full frame' );
            const dst = this[ key ];
            for ( let i = 0; i < n; i++ ) dst[ body[ i * 2 ] ] = body[ i * 2 + 1 ];
        }

        return o + bytes;

    }

}
