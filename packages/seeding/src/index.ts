/**
 * @tip/seeding — the §30 pre-launch gate. Perp-only Brain seeding by replay against local
 * historical bars. Composition of M1–M6; no new machinery here except the driver + gate report.
 *
 * MEMECOIN IS REFUSED (§25) — passing a memecoin agent throws with the §25 citation. Silent
 * skip would hide the mismatch and could quietly ship an unseeded system to production.
 */
export * from './checkpoint.js';
export * from './gate.js';
export * from './seed.js';
