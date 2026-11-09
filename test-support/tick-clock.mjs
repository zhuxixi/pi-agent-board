// Issue #279: advance a fake clock by 1000ms on every Date.now() call, so any
// two render passes that read the clock independently land on different seconds
// (the CI flake condition, made deterministic). Side-effect-only preload module
// for `node --import`; exports nothing.
const base = Date.now();
let calls = 0;
Date.now = () => base + calls++ * 1000;
