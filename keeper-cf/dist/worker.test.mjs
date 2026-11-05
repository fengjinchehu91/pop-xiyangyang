// vendor/secp256k1.ts
/*! noble-secp256k1 - MIT License (c) 2019 Paul Miller (paulmillr.com) */
var freeze = Object.freeze;
var P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
var N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
var Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
var Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
var secp256k1_CURVE = freeze({
  p: P,
  n: N,
  h: 1n,
  a: 0n,
  b: 7n,
  Gx,
  Gy
});
var L = 32;
var isBytes = (a) => {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && a.BYTES_PER_ELEMENT === 1;
};
var abytes = (value, length, title = "") => {
  if (isBytes(value) && (length === void 0 || value.length === length))
    return value;
  const bytes = isBytes(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = (title ? `"${title}" ` : "") + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes) throw new TypeError(message);
  throw new RangeError(message);
};
var cloneBytes = (value) => Uint8Array.from(value);
var snapshotBytes = (value, title, length) => cloneBytes(abytes(value, length, title));
var padh = (n, pad) => n.toString(16).padStart(pad, "0");
var bytesToHex = (bytes) => {
  let hex = "";
  for (const byte of abytes(bytes)) hex += padh(byte, 2);
  return hex;
};
var hexToBytes = (hex) => {
  const e = "hex invalid";
  if (typeof hex !== "string") throw new TypeError(e);
  if (hex.length % 2 || !/^[\da-f]*$/i.test(hex)) throw new RangeError(e);
  const array = new Uint8Array(hex.length / 2);
  for (let ai = 0, hi = 0; ai < array.length; ai++, hi += 2) {
    const n1 = hex.charCodeAt(hi);
    const n2 = hex.charCodeAt(hi + 1);
    array[ai] = ((n1 & 15) + (n1 >> 6) * 9) * 16 + (n2 & 15) + (n2 >> 6) * 9;
  }
  return array;
};
var subtle = () => {
  const s = globalThis?.crypto?.subtle;
  if (s) return s;
  throw new Error("crypto.subtle must be defined, consider polyfill");
};
var concatBytes = (...arrays) => {
  let sum = 0;
  for (const a of arrays) sum += abytes(a).length;
  const res = new Uint8Array(sum);
  let pad = 0;
  for (const a of arrays) {
    res.set(a, pad);
    pad += a.length;
  }
  return res;
};
var randomBytes = (len = L) => {
  const c = globalThis?.crypto;
  if (typeof c?.getRandomValues !== "function")
    throw new Error("crypto.getRandomValues must be defined, consider polyfill");
  return c.getRandomValues(new Uint8Array(len));
};
var big = BigInt;
var arange = (n, min, max, msg = "bad number: out of range") => {
  if (typeof n !== "bigint") throw new TypeError(msg);
  if (min <= n && n < max) return n;
  throw new RangeError(msg);
};
var M = (a, b = P) => (a %= b) >= 0n ? a : b + a;
var modN = (a) => M(a, N);
var invert = (number, modulo) => {
  if (number === 0n) throw new Error("invert: expected non-zero number");
  if (modulo <= 1n) throw new Error("invert: expected modulus > 1, got " + modulo);
  let a = M(number, modulo);
  let b = modulo;
  let x = 0n, u = 1n;
  while (a !== 0n) {
    const q = b / a;
    const r = b - a * q;
    const m = x - u * q;
    b = a, a = r, x = u, u = m;
  }
  const gcd = b;
  if (gcd !== 1n) throw new Error("invert: does not exist");
  return M(x, modulo);
};
var _hash = (name) => {
  const fn = hashes[name];
  if (typeof fn !== "function") throw new Error("hashes." + name + " not set");
  return fn;
};
var callHash = (name, a, b) => abytes(_hash(name)(a, b), L, "digest");
var callHashAsync = async (name, a, b) => abytes(await _hash(name)(a, b), L, "digest");
var apoint = (p) => {
  if (p instanceof Point) return p;
  throw new TypeError("Point expected");
};
var E_BADPOINT = "bad point: not on curve";
var koblitz = (x) => M(M(x * x) * x + 7n);
var FpIsValid = (n) => arange(n, 0n, P);
var FpIsValidNot0 = (n) => arange(n, 1n, P);
var FnIsValidNot0 = (n) => arange(n, 1n, N);
var isEven = (y) => !(y & 1n);
var getPrefix = (y) => Uint8Array.of(isEven(y) ? 2 : 3);
var lift_x = (x) => {
  const c = koblitz(FpIsValidNot0(x));
  let r = 1n;
  for (let num = c, e = (P + 1n) / 4n; e > 0n; e >>= 1n) {
    if (e & 1n) r = r * num % P;
    num = num * num % P;
  }
  if (M(r * r) !== c) throw new Error("sqrt invalid");
  return new Point(x, isEven(r) ? r : M(-r), 1n);
};
var Point = class _Point {
  static BASE;
  static ZERO;
  X;
  Y;
  Z;
  constructor(X, Y, Z) {
    this.X = FpIsValid(X);
    this.Y = FpIsValidNot0(Y);
    this.Z = FpIsValid(Z);
    freeze(this);
  }
  /** Returns the shared curve metadata object by reference.
   * It is readonly only at type level, and mutating it won't retarget arithmetic,
   * which already uses module-load snapshots. */
  static CURVE() {
    return secp256k1_CURVE;
  }
  /** Create 3d xyz point from 2d xy. (0, 0) => (0, 1, 0), not (0, 0, 1) */
  static fromAffine(ap) {
    const { x, y } = ap;
    return x === 0n && y === 0n ? I : new _Point(x, y, 1n);
  }
  /** Convert Uint8Array or hex string to Point. */
  static fromBytes(bytes) {
    abytes(bytes);
    const length = bytes.length;
    const head = bytes[0];
    const x = sliceBytesNumBE(bytes, 1, 33);
    try {
      if (length === 33 && (head === 2 || head === 3)) {
        const p = lift_x(x);
        return head === 3 ? p.negate() : p;
      }
      if (length === 65 && head === 4)
        return new _Point(x, sliceBytesNumBE(bytes, 33, 65), 1n).assertValidity();
    } catch (error) {
      throw new Error(E_BADPOINT);
    }
    throw new Error(E_BADPOINT);
  }
  static fromHex(hex) {
    return _Point.fromBytes(hexToBytes(hex));
  }
  get x() {
    return this.toAffine().x;
  }
  get y() {
    return this.toAffine().y;
  }
  /** Equality check: compare points P&Q. */
  equals(other) {
    const { X: X1, Y: Y1, Z: Z1 } = this;
    const { X: X2, Y: Y2, Z: Z2 } = apoint(other);
    return M(X1 * Z2) === M(X2 * Z1) && M(Y1 * Z2) === M(Y2 * Z1);
  }
  is0() {
    return this.Z === 0n;
  }
  /** Flip point over y coordinate. */
  negate() {
    return new _Point(this.X, M(-this.Y), this.Z);
  }
  /** Point doubling: P+P, complete formula. */
  double() {
    return this.add(this);
  }
  /**
   * Point addition: P+Q, complete, exception-free formula
   * (Renes-Costello-Batina, algo 1 of [2015/1060](https://eprint.iacr.org/2015/1060)).
   * Cost: `12M + 0S + 3*a + 3*b3 + 23add`.
   */
  // prettier-ignore
  add(other) {
    const { X: X1, Y: Y1, Z: Z1 } = this;
    const { X: X2, Y: Y2, Z: Z2 } = apoint(other);
    const a = 0n;
    const b = 7n;
    let X3 = 0n, Y3 = 0n, Z3 = 0n;
    const b3 = M(b * 3n);
    let t0 = M(X1 * X2), t1 = M(Y1 * Y2), t2 = M(Z1 * Z2), t3 = M(X1 + Y1);
    let t4 = M(X2 + Y2);
    t3 = M(t3 * t4);
    t4 = M(t0 + t1);
    t3 = M(t3 - t4);
    t4 = M(X1 + Z1);
    let t5 = M(X2 + Z2);
    t4 = M(t4 * t5);
    t5 = M(t0 + t2);
    t4 = M(t4 - t5);
    t5 = M(Y1 + Z1);
    X3 = M(Y2 + Z2);
    t5 = M(t5 * X3);
    X3 = M(t1 + t2);
    t5 = M(t5 - X3);
    Z3 = M(a * t4);
    X3 = M(b3 * t2);
    Z3 = M(X3 + Z3);
    X3 = M(t1 - Z3);
    Z3 = M(t1 + Z3);
    Y3 = M(X3 * Z3);
    t1 = M(t0 + t0);
    t1 = M(t1 + t0);
    t2 = M(a * t2);
    t4 = M(b3 * t4);
    t1 = M(t1 + t2);
    t2 = M(t0 - t2);
    t2 = M(a * t2);
    t4 = M(t4 + t2);
    t0 = M(t1 * t4);
    Y3 = M(Y3 + t0);
    t0 = M(t5 * t4);
    X3 = M(t3 * X3);
    X3 = M(X3 - t0);
    t0 = M(t3 * t1);
    Z3 = M(t5 * Z3);
    Z3 = M(Z3 + t0);
    return new _Point(X3, Y3, Z3);
  }
  subtract(other) {
    return this.add(apoint(other).negate());
  }
  /**
   * Point-by-scalar multiplication. Scalar must be in range 1 <= n < CURVE.n.
   * Uses {@link wNAF} for base point.
   * Uses fake point to mitigate leakage shape in JS, not as a hard constant-time guarantee.
   * @param n scalar by which point is multiplied
   * @param safe safe mode guards against timing attacks; unsafe mode is faster
   */
  multiply(n, safe = true) {
    if (!safe && n === 0n) return I;
    FnIsValidNot0(n);
    if (n === 1n) return this;
    if (this.equals(G)) return wNAF(n).p;
    let p = I;
    let f = G;
    let d = this;
    for (let i = 0; safe ? i < 256 : n > 0n; i++) {
      if (n & 1n) p = p.add(d);
      else if (safe) f = f.add(d);
      d = d.double();
      n >>= 1n;
    }
    return p;
  }
  multiplyUnsafe(scalar) {
    return this.multiply(scalar, false);
  }
  /** Convert point to 2d xy affine point. (X, Y, Z) ∋ (x=X/Z, y=Y/Z) */
  toAffine() {
    const { X: x, Y: y, Z: z } = this;
    if (z === 0n) return { x: 0n, y: 0n };
    if (z === 1n) return { x, y };
    const iz = invert(z, P);
    if (M(z * iz) !== 1n) throw new Error("inverse invalid");
    return { x: M(x * iz), y: M(y * iz) };
  }
  /** Checks if the point is valid and on-curve. */
  assertValidity() {
    const { x, y } = this.toAffine();
    FpIsValidNot0(x);
    FpIsValidNot0(y);
    if (M(y * y) !== koblitz(x)) throw new Error(E_BADPOINT);
    return this;
  }
  /** Converts point to 33/65-byte Uint8Array. */
  toBytes(isCompressed = true) {
    const { x, y } = this.assertValidity().toAffine();
    const x32b = numTo32b(x);
    if (isCompressed) return concatBytes(getPrefix(y), x32b);
    return concatBytes(Uint8Array.of(4), x32b, numTo32b(y));
  }
  toHex(isCompressed) {
    return bytesToHex(this.toBytes(isCompressed));
  }
};
var G = new Point(Gx, Gy, 1n);
var I = new Point(0n, 1n, 0n);
Point.BASE = G;
Point.ZERO = I;
var bytesToNumBE = (b) => big("0x" + (bytesToHex(b) || "0"));
var sliceBytesNumBE = (b, from, to) => bytesToNumBE(b.subarray(from, to));
var numTo32b = (num) => hexToBytes(padh(arange(num, 0n, 2n ** 256n), L * 2));
var secretKeyToScalar = (secretKey) => {
  const num = bytesToNumBE(abytes(secretKey, L, "secret key"));
  return arange(num, 1n, N, "invalid secret key: outside of range");
};
var highS = (n) => n > N >> 1n;
var getRecoveryBit = (x, y, r) => (x === r ? 0 : 2) | Number(y & 1n);
var getPublicKey = (privKey, isCompressed = true) => {
  return G.multiply(secretKeyToScalar(privKey)).toBytes(isCompressed);
};
var isValidSecretKey = (secretKey) => {
  try {
    return !!secretKeyToScalar(secretKey);
  } catch (error) {
    return false;
  }
};
var isValidPublicKey = (publicKey, isCompressed) => {
  try {
    const l = publicKey.length;
    if (isCompressed === true && l !== 33) return false;
    if (isCompressed === false && l !== 65) return false;
    return !!Point.fromBytes(publicKey);
  } catch (error) {
    return false;
  }
};
var assertRecoveryBit = (recovery) => {
  if (recovery != null && [0, 1, 2, 3].includes(recovery)) return recovery;
  throw new Error("invalid recovery id");
};
var assertSigFormat = (format) => {
  if (format === "der")
    throw new Error('Signature format "der" is not supported: switch to noble-curves');
  if (format != null && format !== SIG_COMPACT && format !== SIG_RECOVERED)
    throw new Error("Signature format must be one of: compact, recovered, der");
};
var assertSigLength = (sig, format = SIG_COMPACT) => {
  assertSigFormat(format);
  const bytes = abytes(sig, void 0, "signature");
  const len = 64 + Number(format === SIG_RECOVERED);
  if (bytes.length !== len)
    throw new Error(`Signature format "${format}" expects Uint8Array with length ${len}`);
  return bytes;
};
var Signature = class _Signature {
  r;
  s;
  recovery;
  constructor(r, s, recovery) {
    this.r = FnIsValidNot0(r);
    this.s = FnIsValidNot0(s);
    if (recovery != null) this.recovery = assertRecoveryBit(recovery);
    freeze(this);
  }
  static fromBytes(b, format = SIG_COMPACT) {
    b = assertSigLength(b, format);
    let rec;
    if (format === SIG_RECOVERED) {
      rec = b[0];
      b = b.subarray(1);
    }
    const r = sliceBytesNumBE(b, 0, L);
    const s = sliceBytesNumBE(b, L, 64);
    return new _Signature(r, s, rec);
  }
  addRecoveryBit(bit) {
    return new _Signature(this.r, this.s, bit);
  }
  hasHighS() {
    return highS(this.s);
  }
  toBytes(format = SIG_COMPACT) {
    assertSigFormat(format);
    const { r, s, recovery } = this;
    const res = concatBytes(numTo32b(r), numTo32b(s));
    if (format === SIG_RECOVERED) {
      return concatBytes(Uint8Array.of(assertRecoveryBit(recovery)), res);
    }
    return res;
  }
};
var MAX_PREHASHED_BYTES = 8192;
var E_MSGBIG = "input is too large";
var oversizedMsg = (bytes, prehash) => !prehash && bytes.length > MAX_PREHASHED_BYTES;
var bits2int = (bytes) => {
  if (oversizedMsg(bytes)) throw new Error(E_MSGBIG);
  const delta = bytes.length * 8 - 256;
  const num = bytesToNumBE(bytes);
  return delta > 0 ? num >> big(delta) : num;
};
var bits2int_modN = (bytes) => modN(bits2int(abytes(bytes)));
var SIG_COMPACT = "compact";
var SIG_RECOVERED = "recovered";
var _sha = "SHA-256";
var hashes = {
  hmacSha256Async: async (key, message) => {
    const s = subtle();
    const k = await s.importKey("raw", key, { name: "HMAC", hash: _sha }, false, ["sign"]);
    return new Uint8Array(await s.sign("HMAC", k, message));
  },
  hmacSha256: void 0,
  sha256Async: async (msg) => new Uint8Array(await subtle().digest(_sha, msg)),
  sha256: void 0
};
var prepMsg = (msg, prehash, async_) => {
  const message = abytes(msg, void 0, "message");
  if (!prehash) return message;
  return async_ ? callHashAsync("sha256Async", message) : callHash("sha256", message);
};
var NULL = /* @__PURE__ */ new Uint8Array(0);
var byte0 = /* @__PURE__ */ Uint8Array.of(0);
var byte1 = /* @__PURE__ */ Uint8Array.of(1);
var _drbgErr = "drbg: tried max amount of iterations";
var hmacDrbg = (seed, pred) => {
  let v = new Uint8Array(L);
  let k = new Uint8Array(L);
  let i = 0;
  const reset = () => {
    v.fill(1);
    k.fill(0);
  };
  const h = (...b) => callHash("hmacSha256", k, concatBytes(v, ...b));
  const reseed = (seed2 = NULL) => {
    k = h(byte0, seed2);
    v = h();
    if (seed2.length === 0) return;
    k = h(byte1, seed2);
    v = h();
  };
  const gen = () => {
    if (i++ >= 1e3) throw new Error(_drbgErr);
    v = h();
    return v;
  };
  reset();
  reseed(seed);
  let res = void 0;
  while (!(res = pred(gen()))) reseed();
  reset();
  return res;
};
var _sign = (messageHash, secretKey, opts, drbg) => {
  const [lowS, , format, extraEntropy] = opts;
  const h1i = bits2int_modN(messageHash);
  const d = secretKeyToScalar(secretKey);
  const seedArgs = [numTo32b(d), numTo32b(h1i)];
  if (extraEntropy != null && extraEntropy !== false) {
    seedArgs.push(
      abytes(extraEntropy === true ? randomBytes(L) : extraEntropy, void 0, "extraEntropy")
    );
  }
  const k2sig = (kBytes) => {
    const k = bits2int(kBytes);
    if (!(1n <= k && k < N)) return;
    const ik = invert(k, N);
    const q = G.multiply(k).toAffine();
    const r = modN(q.x);
    if (r === 0n) return;
    const s = modN(ik * (h1i + r * d));
    if (s === 0n) return;
    let recovery = getRecoveryBit(q.x, q.y, r);
    let normS = s;
    if (lowS && highS(s)) {
      normS = N - s;
      recovery ^= 1;
    }
    const sig = new Signature(r, normS, recovery);
    return sig.toBytes(format);
  };
  return drbg(concatBytes(...seedArgs), k2sig);
};
var setDefaults = (opts, own = false) => {
  const e = opts.extraEntropy;
  return [
    opts.lowS ?? true,
    opts.prehash ?? true,
    opts.format ?? SIG_COMPACT,
    own && e != null && typeof e !== "boolean" ? snapshotBytes(e, "extraEntropy") : e
  ];
};
var sign = (message, secretKey, opts = {}) => {
  const o = setDefaults(opts);
  assertSigFormat(o[2]);
  const msg = prepMsg(message, o[1], false);
  return _sign(msg, secretKey, o, hmacDrbg);
};
var randomSecretKey = (seed) => {
  seed = seed === void 0 ? randomBytes(48) : seed;
  abytes(seed);
  if (seed.length < 48 || seed.length > 1024) throw new RangeError("expected 48-1024b");
  const num = M(bytesToNumBE(seed), N - 1n);
  return numTo32b(num + 1n);
};
var utils = /* @__PURE__ */ freeze({
  isValidSecretKey,
  isValidPublicKey,
  randomSecretKey
});
var precompute = () => {
  const points = [];
  let p = G;
  let b = p;
  for (let w = 0; w < 33; w++) {
    b = p;
    points.push(b);
    for (let i = 1; i < 128; i++) {
      b = b.add(p);
      points.push(b);
    }
    p = b.double();
  }
  return points;
};
var Gpows = void 0;
var ctneg = (cnd, p) => {
  const n = p.negate();
  return cnd ? n : p;
};
var wNAF = (n) => {
  const comp = Gpows || (Gpows = precompute());
  let p = I;
  let f = G;
  for (let w = 0; w < 33; w++) {
    let wbits = Number(n & 255n);
    n >>= 8n;
    if (wbits > 128) {
      wbits -= 256;
      n += 1n;
    }
    const off = w * 128;
    const offP = off + Math.abs(wbits) - 1;
    const isOddW = w % 2 !== 0;
    const isNeg = wbits < 0;
    if (wbits === 0) {
      f = f.add(ctneg(isOddW, comp[off]));
    } else {
      p = p.add(ctneg(isNeg, comp[offP]));
    }
  }
  if (n !== 0n) throw new Error("invalid wnaf");
  return { p, f };
};

// vendor/hashes/_u64.ts
var U32_MASK64 = /* @__PURE__ */ (() => BigInt(2 ** 32 - 1))();
var _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
  if (le) return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE2) {
  const h = fromNumH(n);
  const l = fromNumL(n);
  view.setUint32(byteOffset, isLE2 ? l : h, isLE2);
  view.setUint32(byteOffset + 4, isLE2 ? h : l, isLE2);
}

// vendor/hashes/utils.ts
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abool(value, title = "") {
  if (typeof value !== "boolean")
    throw new TypeError(atitle(title) + "expected boolean, got type=" + typeof value);
  return value;
}
function abytes2(value, length, title = "") {
  if (isBytes2(value) && (length === void 0 || value.length === length))
    return value;
  if (length !== void 0) anumber(length, "length");
  const bytes = isBytes2(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes) throw new TypeError(message);
  throw new RangeError(message);
}
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new TypeError("expected hash wrapped by utils.createHasher");
  anumber(h.outputLen);
  anumber(h.blockLen);
  if (h.outputLen < 1 || h.blockLen < 1) throw new Error("hash blockLen / outputLen must be >= 1");
}
var aobject = (value, label2) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(
      (label2 === "object" ? "" : `"${label2}" `) + "expected object, got type=" + typeof value
    );
};
var aopts = (value, label2) => {
  aobject(value, label2);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label2}" expected plain object`);
  if (Object.hasOwn(value, "__proto__")) throw new TypeError(`"${label2}.__proto__" is not allowed`);
};
function aexists(instance, checkFinished = true) {
  if (instance.destroyed) throw new Error("hash was destroyed");
  if (checkFinished && instance.finished) throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes2(out, void 0, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function u32(arr) {
  return new Uint32Array(
    arr.buffer,
    arr.byteOffset,
    Math.floor(arr.byteLength / 4)
  );
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word2, shift) {
  return word2 << 32 - shift | word2 >>> shift;
}
var isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
function byteSwap(word2) {
  return word2 << 24 & 4278190080 | word2 << 8 & 16711680 | word2 >>> 8 & 65280 | word2 >>> 24 & 255;
}
function byteSwap32(arr) {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = byteSwap(arr[i]);
  }
  return arr;
}
var swap32IfBE = isLE ? (u) => u : byteSwap32;
function checkOpts(defaults, opts, title = "opts") {
  aopts(defaults, "defaults");
  if (opts !== void 0) aopts(opts, title);
  const merged = Object.assign(/* @__PURE__ */ Object.create(null), defaults, opts);
  return merged;
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
var oidNist = (suffix) => ({
  // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
  // Larger suffix values would need base-128 OID encoding and a different length byte.
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// vendor/hashes/sha3.ts
var _0n = BigInt(0);
var _1n = BigInt(1);
var _2n = BigInt(2);
var _7n = BigInt(7);
var _256n = BigInt(256);
var _0x71n = BigInt(113);
var SHA3_PI = [];
var SHA3_ROTL = [];
var _SHA3_IOTA = [];
for (let round = 0, R = _1n, x = 1, y = 0; round < 24; round++) {
  [x, y] = [y, (2 * x + 3 * y) % 5];
  SHA3_PI.push(2 * (5 * y + x));
  SHA3_ROTL.push((round + 1) * (round + 2) / 2 % 64);
  let t = _0n;
  for (let j = 0; j < 7; j++) {
    R = (R << _1n ^ (R >> _7n) * _0x71n) % _256n;
    if (R & _2n) t ^= _1n << (_1n << BigInt(j)) - _1n;
  }
  _SHA3_IOTA.push(t);
}
var IOTAS = split(_SHA3_IOTA, true);
var SHA3_IOTA_H = IOTAS[0];
var SHA3_IOTA_L = IOTAS[1];
var rotlSH = (h, l, s) => h << s | l >>> 32 - s;
var rotlSL = (h, l, s) => l << s | h >>> 32 - s;
var rotlBH = (h, l, s) => l << s - 32 | h >>> 64 - s;
var rotlBL = (h, l, s) => h << s - 32 | l >>> 64 - s;
var rotlH = (h, l, s) => s > 32 ? rotlBH(h, l, s) : rotlSH(h, l, s);
var rotlL = (h, l, s) => s > 32 ? rotlBL(h, l, s) : rotlSL(h, l, s);
var B = new Uint32Array(5 * 2);
function keccakP(s, rounds = 24) {
  if (!(s instanceof Uint32Array))
    throw new TypeError('"s" expected Uint32Array(50), got type=' + typeof s);
  if (s.length !== 50) throw new RangeError('"s" expected Uint32Array(50), got length=' + s.length);
  anumber(rounds, "rounds");
  if (rounds < 1 || rounds > 24) throw new Error('"rounds" expected integer 1..24');
  for (let round = 24 - rounds; round < 24; round++) {
    for (let x = 0; x < 10; x++) B[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
    for (let x = 0; x < 10; x += 2) {
      const idx1 = (x + 8) % 10;
      const idx0 = (x + 2) % 10;
      const B0 = B[idx0];
      const B1 = B[idx0 + 1];
      const Th = rotlH(B0, B1, 1) ^ B[idx1];
      const Tl = rotlL(B0, B1, 1) ^ B[idx1 + 1];
      for (let y = 0; y < 50; y += 10) {
        s[x + y] ^= Th;
        s[x + y + 1] ^= Tl;
      }
    }
    let curH = s[2];
    let curL = s[3];
    for (let t = 0; t < 24; t++) {
      const shift = SHA3_ROTL[t];
      const Th = rotlH(curH, curL, shift);
      const Tl = rotlL(curH, curL, shift);
      const PI = SHA3_PI[t];
      curH = s[PI];
      curL = s[PI + 1];
      s[PI] = Th;
      s[PI + 1] = Tl;
    }
    for (let y = 0; y < 50; y += 10) {
      const b0 = s[y], b1 = s[y + 1], b2 = s[y + 2], b3 = s[y + 3];
      s[y] ^= ~s[y + 2] & s[y + 4];
      s[y + 1] ^= ~s[y + 3] & s[y + 5];
      s[y + 2] ^= ~s[y + 4] & s[y + 6];
      s[y + 3] ^= ~s[y + 5] & s[y + 7];
      s[y + 4] ^= ~s[y + 6] & s[y + 8];
      s[y + 5] ^= ~s[y + 7] & s[y + 9];
      s[y + 6] ^= ~s[y + 8] & b0;
      s[y + 7] ^= ~s[y + 9] & b1;
      s[y + 8] ^= ~b0 & b2;
      s[y + 9] ^= ~b1 & b3;
    }
    s[0] ^= SHA3_IOTA_H[round];
    s[1] ^= SHA3_IOTA_L[round];
  }
  clean(B);
}
var Keccak = class _Keccak {
  state;
  pos = 0;
  posOut = 0;
  finished = false;
  state32;
  destroyed = false;
  blockLen;
  suffix;
  outputLen;
  canXOF;
  enableXOF = false;
  rounds;
  // NOTE: we accept arguments in bytes instead of bits here.
  constructor(blockLen, suffix, outputLen, enableXOF = false, rounds = 24) {
    anumber(blockLen, "blockLen");
    anumber(suffix, "suffix");
    anumber(rounds, "rounds");
    abool(enableXOF, "enableXOF");
    this.blockLen = blockLen;
    this.suffix = suffix;
    this.outputLen = outputLen;
    this.enableXOF = enableXOF;
    this.canXOF = enableXOF;
    this.rounds = rounds;
    anumber(outputLen, "outputLen");
    if (!(0 < blockLen && blockLen < 200)) throw new Error('"blockLen" must be 1..199');
    this.state = new Uint8Array(200);
    this.state32 = u32(this.state);
  }
  clone() {
    return this._cloneInto();
  }
  keccak() {
    swap32IfBE(this.state32);
    keccakP(this.state32, this.rounds);
    swap32IfBE(this.state32);
    this.posOut = 0;
    this.pos = 0;
  }
  update(data) {
    aexists(this);
    abytes2(data);
    const { blockLen, state, state32 } = this;
    const len = data.length;
    const canUseU32 = blockLen % 4 === 0 && data.byteOffset % 4 === 0;
    const blockLen32 = blockLen / 4;
    const data32 = canUseU32 && len >= blockLen ? u32(data) : void 0;
    for (let pos = 0; pos < len; ) {
      if (data32 !== void 0 && this.pos === 0 && pos % 4 === 0 && len - pos >= blockLen) {
        for (let i = 0, o = pos / 4; i < blockLen32; i++) state32[i] ^= data32[o + i];
        pos += blockLen;
        this.pos = blockLen;
        this.keccak();
        continue;
      }
      const take = Math.min(blockLen - this.pos, len - pos);
      for (let i = 0; i < take; i++) state[this.pos++] ^= data[pos++];
      if (this.pos === blockLen) this.keccak();
    }
    return this;
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    const { state, suffix, pos, blockLen } = this;
    state[pos] ^= suffix;
    if ((suffix & 128) !== 0 && pos === blockLen - 1) this.keccak();
    state[blockLen - 1] ^= 128;
    this.keccak();
  }
  writeInto(out) {
    aexists(this, false);
    abytes2(out);
    this.finish();
    const bufferOut = this.state;
    const { blockLen } = this;
    for (let pos = 0, len = out.length; pos < len; ) {
      if (this.posOut >= blockLen) this.keccak();
      const take = Math.min(blockLen - this.posOut, len - pos);
      out.set(bufferOut.subarray(this.posOut, this.posOut + take), pos);
      this.posOut += take;
      pos += take;
    }
    return out;
  }
  xofInto(out) {
    if (!this.enableXOF) throw new Error("XOF is not enabled");
    return this.writeInto(out);
  }
  xof(bytes) {
    anumber(bytes);
    return this.xofInto(new Uint8Array(bytes));
  }
  digestInto(out) {
    aoutput(out, this);
    if (this.finished) throw new Error("digest() was already called");
    this.writeInto(out.length === this.outputLen ? out : out.subarray(0, this.outputLen));
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.outputLen);
    this.digestInto(out);
    return out;
  }
  destroy() {
    this.destroyed = true;
    clean(this.state);
  }
  _cloneInto(to) {
    const { blockLen, suffix, outputLen, rounds, enableXOF } = this;
    to ||= new _Keccak(blockLen, suffix, outputLen, enableXOF, rounds);
    to.blockLen = blockLen;
    to.state32.set(this.state32);
    to.pos = this.pos;
    to.posOut = this.posOut;
    to.finished = this.finished;
    to.rounds = rounds;
    to.suffix = suffix;
    to.outputLen = outputLen;
    to.enableXOF = enableXOF;
    to.canXOF = this.canXOF;
    to.destroyed = this.destroyed;
    return to;
  }
};
var genKeccak = (suffix, blockLen, outputLen, info = {}) => createHasher(() => new Keccak(blockLen, suffix, outputLen), info);
var keccak_256 = /* @__PURE__ */ genKeccak(1, 136, 32);

// vendor/hashes/_md.ts
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class {
  blockLen;
  outputLen;
  canXOF = false;
  padOffset;
  isLE;
  // For partial updates less than block size
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE2) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE2;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes2(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    let processed = false;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen) this.process(dataView, pos);
        processed = true;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
        processed = true;
      }
    }
    this.length += data.length;
    if (processed) this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE: isLE2 } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    buffer.fill(0, pos);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      buffer.fill(0);
    }
    setU64FromNum(view, blockLen - 8, this.length * 8, isLE2);
    this.process(view, 0);
    this.roundClean();
    const oview = out === buffer ? view : createView(out);
    const len = this.outputLen;
    const outLen = len / 4;
    const state = this.get();
    if (len % 4 || outLen > state.length) throw new Error("invalid outputLen");
    for (let i = 0; i < outLen; i++) oview.setUint32(4 * i, state[i], isLE2);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneIntoMeta(to) {
    const { buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (pos) to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// vendor/hashes/sha2.ts
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA2_32B = class extends HashMD {
  // We cannot use array here since array allows indexing by variable
  // which means optimizer/compiler cannot use registers.
  // Numeric initializers matter: starting the fields as `undefined` changes
  // V8's field representation and makes sha256 3x slower (measured).
  A = 0;
  B = 0;
  C = 0;
  D = 0;
  E = 0;
  F = 0;
  G = 0;
  H = 0;
  constructor(outputLen, IV) {
    super(64, outputLen, 8, false);
    this.A = IV[0] | 0;
    this.B = IV[1] | 0;
    this.C = IV[2] | 0;
    this.D = IV[3] | 0;
    this.E = IV[4] | 0;
    this.F = IV[5] | 0;
    this.G = IV[6] | 0;
    this.H = IV[7] | 0;
  }
  get() {
    const { A, B: B2, C, D, E, F, G: G2, H } = this;
    return [A, B2, C, D, E, F, G2, H];
  }
  // prettier-ignore
  set(A, B2, C, D, E, F, G2, H) {
    this.A = A | 0;
    this.B = B2 | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G2 | 0;
    this.H = H | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor()).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4) SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B: B2, C, D, E, F, G: G2, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G2) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B2, C) | 0;
      H = G2;
      G2 = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B2;
      B2 = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B2 = B2 + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G2 = G2 + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B2, C, D, E, F, G2, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.destroyed = true;
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var _SHA256 = class extends SHA2_32B {
  constructor() {
    super(32, SHA256_IV);
  }
};
var sha256 = /* @__PURE__ */ createHasher(
  () => new _SHA256(),
  /* @__PURE__ */ oidNist(1)
);

// vendor/hashes/hmac.ts
var _HMAC = class {
  oHash;
  iHash;
  blockLen;
  outputLen;
  canXOF = false;
  finished = false;
  destroyed = false;
  constructor(hash, key) {
    ahash(hash);
    abytes2(key, void 0, "key");
    this.iHash = hash.create();
    if (typeof this.iHash.update !== "function") throw new Error("expected Hash instance");
    this.blockLen = this.iHash.blockLen;
    this.outputLen = this.iHash.outputLen;
    const blockLen = this.blockLen;
    const pad = new Uint8Array(blockLen);
    pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0; i < pad.length; i++) pad[i] ^= 54;
    this.iHash.update(pad);
    this.oHash = hash.create();
    for (let i = 0; i < pad.length; i++) pad[i] ^= 54 ^ 92;
    this.oHash.update(pad);
    clean(pad);
  }
  update(buf) {
    aexists(this);
    this.iHash.update(buf);
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const buf = out.subarray(0, this.outputLen);
    this.iHash.digestInto(buf);
    this.oHash.update(buf);
    this.oHash.digestInto(buf);
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.oHash.outputLen);
    this.digestInto(out);
    return out;
  }
  _cloneInto(to) {
    to ||= Object.create(Object.getPrototypeOf(this), {});
    const { oHash, iHash, finished, destroyed, blockLen, outputLen, canXOF } = this;
    to = to;
    to.finished = finished;
    to.destroyed = destroyed;
    to.blockLen = blockLen;
    to.outputLen = outputLen;
    to.canXOF = canXOF;
    to.oHash = oHash._cloneInto(to.oHash);
    to.iHash = iHash._cloneInto(to.iHash);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = true;
    this.oHash.destroy();
    this.iHash.destroy();
  }
};
var hmac = /* @__PURE__ */ (() => {
  const hmac_ = ((hash, key, message) => new _HMAC(hash, key).update(message).digest());
  hmac_.create = (hash, key) => new _HMAC(hash, key);
  return hmac_;
})();

// src/worker.js
hashes.hmacSha256 = (k, m) => hmac(sha256, k, m);
hashes.sha256 = sha256;
var DEFAULTS = {
  MINER: "0x363CBA25a4bC4617fAF017b1e0728f4AB7473E17",
  DEPLOY_BLOCK: 131739316,
  CHAIN_ID: 56,
  RPC_URL: "https://bsc-rpc.publicnode.com",
  RPC_URL_2: "https://bsc-dataseed.bnbchain.org",
  EXPLORER: "https://bscscan.com",
  CHECK_MINUTES: 25,
  // refresh the price / valuation at least this often
  SETTLE_HOURS: "",
  // empty = automatic: hourly for up to 20 wallets, then longer (100 wallets: every 5 h; 480+: daily)
  BATCH: 100,
  // wallets per settleMany transaction
  MAX_SETTLE_TX: 2,
  // settle transactions per run (the rest continue in the next run)
  LOG_CHUNK: 1e3,
  // blocks per eth_getLogs (several free nodes allow at most ~1000)
  MAX_LOG_CALLS: 12,
  // eth_getLogs calls per run
  MAX_GAS_GWEI: 1,
  // never pay more than this per gas
  CONFIRMATIONS: 5
};
var LOG_RPCS = [
  "https://bsc-rpc.publicnode.com",
  "https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3",
  "https://bsc.drpc.org",
  "https://bsc.blockpi.network/v1/rpc/public",
  "https://binance.llamarpc.com",
  "https://bsc-pokt.nodies.app",
  "https://bsc.meowrpc.com",
  "https://bsc-mainnet.public.blastapi.io"
];
var SUBREQUEST_BUDGET = 45;
var KEY_SLOT = "keeper-key";
var REASONS = [
  [1, "\u7BA1\u7406\u5458\u5DF2\u6682\u505C"],
  [2, "\u6D41\u52A8\u6027\u4F30\u503C\u6682\u4E0D\u53EF\u7528\uFF08\u4EF7\u683C\u5386\u53F2\u4E0D\u8DB3\u3001\u504F\u79BB\u8FC7\u5927\u6216\u6D41\u52A8\u6027\u4E0D\u8DB3\uFF09"],
  [4, "\u559C\u7F8A\u7F8A\u4EF7\u683C\u6682\u4E0D\u53EF\u7528\uFF08\u9700\u8981\u7EA6 30 \u5206\u949F\u4EF7\u683C\u5386\u53F2\uFF09"],
  [8, "\u8FD0\u8425\u94B1\u5305\u7684\u559C\u7F8A\u7F8A\u4F59\u989D\u6216\u6388\u6743\u989D\u5EA6\u4E0D\u8DB3"],
  [16, "\u6316\u77FF\u5DF2\u6C38\u4E45\u7ED3\u675F"]
];
var enc = new TextEncoder();
var toHex = (b) => {
  let s = "0x";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
};
var fromHex = (h) => {
  if (h.startsWith("0x") || h.startsWith("0X")) h = h.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(h)) throw new Error("bad hex");
  if (h.length % 2) h = "0" + h;
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return b;
};
var concat = (arr) => {
  let n = 0;
  for (const a of arr) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arr) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};
var intBytes = (v) => {
  v = BigInt(v);
  if (v < 0n) throw new Error("negative");
  if (v === 0n) return new Uint8Array(0);
  return fromHex(v.toString(16));
};
var stripZeros = (b) => {
  let i = 0;
  while (i < b.length && b[i] === 0) i++;
  return b.subarray(i);
};
var qty = (v) => "0x" + BigInt(v).toString(16);
var word = (v) => BigInt(v).toString(16).padStart(64, "0");
var selector = (sig) => toHex(keccak_256(enc.encode(sig)).subarray(0, 4)).slice(2);
var topicOf = (sig) => toHex(keccak_256(enc.encode(sig)));
var big2 = (h) => h && h !== "0x" ? BigInt(h) : 0n;
var SEL = {
  checkpoint: selector("checkpoint()"),
  settleMany: selector("settleMany(address[])"),
  accruing: selector("accruing()"),
  pauseReasons: selector("pauseReasons()"),
  lastCheckpointTime: selector("lastCheckpointTime()"),
  operator: selector("OPERATOR()"),
  owner: selector("owner()")
};
var T_JOINED = topicOf("Joined(address,address,address,uint256)");
var T_DEPOSITED = topicOf("Deposited(address,uint256,uint128,uint256,uint256,uint256,uint256,uint256,uint256)");
var T_WITHDRAWN = topicOf("Withdrawn(address,uint128,uint256,uint256,uint256,uint256)");
function rlp(x) {
  if (Array.isArray(x)) {
    const parts = x.map(rlp);
    let len = 0;
    for (const p of parts) len += p.length;
    return concat([rlpLen(len, 192), ...parts]);
  }
  if (x.length === 1 && x[0] < 128) return x;
  return concat([rlpLen(x.length, 128), x]);
}
function rlpLen(len, offset) {
  if (len < 56) return Uint8Array.of(offset + len);
  const lb = intBytes(len);
  return concat([Uint8Array.of(offset + 55 + lb.length), lb]);
}
function signLegacyTx(tx, key) {
  const base = [
    intBytes(tx.nonce),
    intBytes(tx.gasPrice),
    intBytes(tx.gasLimit),
    fromHex(tx.to),
    intBytes(tx.value || 0),
    fromHex(tx.data || "0x")
  ];
  const digest = keccak_256(rlp([...base, intBytes(tx.chainId), new Uint8Array(0), new Uint8Array(0)]));
  const sig = sign(digest, key, { prehash: false, format: "recovered" });
  const v = BigInt(tx.chainId) * 2n + 35n + BigInt(sig[0]);
  const raw = rlp([...base, intBytes(v), stripZeros(sig.subarray(1, 33)), stripZeros(sig.subarray(33, 65))]);
  return { raw: toHex(raw), hash: toHex(keccak_256(raw)) };
}
function addressOf(key) {
  const pub = getPublicKey(key, false);
  return toHex(keccak_256(pub.subarray(1)).subarray(12));
}
function encodeSettleMany(list) {
  let s = SEL.settleMany + word(32) + word(list.length);
  for (const a of list) s += a.slice(2).toLowerCase().padStart(64, "0");
  return "0x" + s;
}
var Rpc = class {
  constructor(urls, budget) {
    this.urls = urls;
    this.left = budget;
    this.id = 1;
  }
  async post(url, body) {
    if (this.left <= 0) throw new Error("\u672C\u6B21\u8FD0\u884C\u7684\u7F51\u7EDC\u8BF7\u6C42\u6B21\u6570\u5DF2\u7528\u5B8C");
    this.left--;
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2e4)
    });
    if (!r.ok) throw new Error(`\u8282\u70B9\u8FD4\u56DE HTTP ${r.status}`);
    return r.json();
  }
  // calls: [[method, params], ...] -> [{result} | {error}, ...] in the same order
  async batch(calls) {
    let lastErr = null;
    let lastOut = null;
    for (const url of this.urls) {
      const reqs = calls.map(([method, params]) => ({ jsonrpc: "2.0", id: this.id++, method, params }));
      let res = null;
      try {
        res = reqs.length === 1 ? [await this.post(url, reqs[0])] : await this.post(url, reqs);
        if (!Array.isArray(res)) res = null;
      } catch (e) {
        lastErr = e;
        res = null;
      }
      if (!res && reqs.length > 1) {
        try {
          res = [];
          for (const q of reqs) res.push(await this.post(url, q));
        } catch (e) {
          lastErr = e;
          res = null;
        }
      }
      if (!res) continue;
      const byId = new Map(res.map((x) => [x && x.id, x]));
      const out = reqs.map((q) => byId.get(q.id) || { error: { message: "\u8282\u70B9\u6CA1\u6709\u8FD4\u56DE\u7ED3\u679C" } });
      if (out.every((x) => x.error && !/revert|nonce|known|underpriced|insufficient/i.test(x.error.message || ""))) {
        lastOut = out;
        continue;
      }
      return out;
    }
    if (lastOut) return lastOut;
    throw lastErr || new Error("\u65E0\u6CD5\u8FDE\u63A5 BSC \u8282\u70B9");
  }
  async call(method, params) {
    const [r] = await this.batch([[method, params]]);
    if (r.error) throw new Error(r.error.message || "\u8282\u70B9\u8FD4\u56DE\u9519\u8BEF");
    return r.result;
  }
};
function config(env) {
  const num = (k) => {
    const v = env[k];
    return v === void 0 || v === "" ? DEFAULTS[k] : Number(v);
  };
  const str = (k) => env[k] ? String(env[k]).trim() : DEFAULTS[k];
  const rpcs = [str("RPC_URL"), str("RPC_URL_2")].filter((u, i, a) => u && a.indexOf(u) === i);
  return {
    miner: str("MINER").toLowerCase(),
    deployBlock: num("DEPLOY_BLOCK"),
    chainId: num("CHAIN_ID"),
    rpcs,
    logRpcs: env.LOG_RPC_URLS ? String(env.LOG_RPC_URLS).split(",").map((x) => x.trim()).filter(Boolean) : [.../* @__PURE__ */ new Set([...LOG_RPCS, ...rpcs])],
    explorer: str("EXPLORER"),
    checkMinutes: Math.max(10, num("CHECK_MINUTES")),
    settleHours: env.SETTLE_HOURS ? Math.max(0.25, Number(env.SETTLE_HOURS)) : null,
    batch: Math.min(150, Math.max(1, num("BATCH"))),
    maxSettleTx: Math.max(1, num("MAX_SETTLE_TX")),
    logChunk: Math.max(50, num("LOG_CHUNK")),
    maxLogCalls: Math.max(1, num("MAX_LOG_CALLS")),
    maxGasWei: BigInt(Math.round(num("MAX_GAS_GWEI") * 1e9)),
    confirmations: num("CONFIRMATIONS")
  };
}
function freshState(c) {
  return {
    v: 1,
    miner: c.miner,
    scanned: c.deployBlock - 1,
    chunk: c.logChunk,
    users: {},
    // address -> [liquidity (decimal string), hasReferrer (0/1)]
    settleCursor: 0,
    lastSettle: 0,
    lastSentAt: 0,
    lastGasPrice: "0",
    pending: [],
    // recently sent transactions not yet mined (by nonce)
    load: 1,
    // 0.25..1: shrinks automatically if a run gets cut off (CPU limit)
    busy: null,
    balHist: [],
    status: null
  };
}
var memState = null;
async function loadState(env, c) {
  if (!env.STATE || typeof env.STATE.get !== "function") return { ok: false, why: "\u8FD8\u6CA1\u6709\u7ED1\u5B9A KV\uFF08\u53D8\u91CF\u540D STATE\uFF09", s: freshState(c) };
  try {
    let s = await env.STATE.get("state", "json");
    if (memState && memState.miner === c.miner && (!s || (memState.seq || 0) >= (s.seq || 0))) s = JSON.parse(JSON.stringify(memState));
    if (!s || s.v !== 1 || s.miner !== c.miner) return { ok: true, s: freshState(c) };
    return { ok: true, s };
  } catch (e) {
    return { ok: false, why: "\u8BFB\u53D6 KV \u5931\u8D25\uFF1A" + (e?.message || e), s: freshState(c) };
  }
}
function applyLog(users, l) {
  if (l.removed) return;
  const t0 = (l.topics[0] || "").toLowerCase();
  if (t0 !== T_JOINED && t0 !== T_DEPOSITED && t0 !== T_WITHDRAWN) return;
  const u = "0x" + l.topics[1].slice(26).toLowerCase();
  const e = users[u] || (users[u] = ["0", 0]);
  if (t0 === T_JOINED) {
    e[1] = big2(l.topics[2]) !== 0n ? 1 : 0;
  } else {
    const liq = BigInt("0x" + l.data.slice(2, 66));
    let v = BigInt(e[0]) + (t0 === T_DEPOSITED ? liq : -liq);
    if (v < 0n) v = 0n;
    e[0] = v.toString();
  }
}
var settleList = (s) => Object.keys(s.users).filter((a) => s.users[a][1] === 1 && s.users[a][0] !== "0");
var cachedKey = null;
function keyFromString(str, what) {
  str = String(str).trim();
  if (cachedKey && cachedKey.str === str) return cachedKey;
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(str)) throw new Error(`${what}\u683C\u5F0F\u4E0D\u5BF9\uFF1A\u5E94\u8BE5\u662F 64 \u4F4D\u5341\u516D\u8FDB\u5236\u79C1\u94A5`);
  const key = fromHex(str);
  let addr;
  try {
    addr = addressOf(key);
  } catch {
    throw new Error(`${what}\u4E0D\u662F\u6709\u6548\u7684\u79C1\u94A5`);
  }
  cachedKey = { str, key, addr };
  return cachedKey;
}
async function resolveKey(env, loaded, s) {
  if (env.KEEPER_KEY) return keyFromString(env.KEEPER_KEY, "KEEPER_KEY ");
  if (!loaded.ok) throw new Error(loaded.why + "\uFF0C\u65E0\u6CD5\u8BFB\u53D6\u68C0\u67E5\u94B1\u5305");
  let stored;
  try {
    stored = await env.STATE.get(KEY_SLOT);
  } catch (e) {
    throw new Error("\u8BFB\u53D6\u68C0\u67E5\u94B1\u5305\u5931\u8D25\uFF1A" + (e?.message || e));
  }
  if (stored) return keyFromString(stored, "\u4FDD\u5B58\u7684\u68C0\u67E5\u94B1\u5305");
  if (s.generatedAddr) {
    throw new Error("\u627E\u4E0D\u5230\u4E4B\u524D\u521B\u5EFA\u7684\u68C0\u67E5\u94B1\u5305\u5BC6\u94A5\u3002\u4E3A\u4E86\u4E0D\u4E22\u5931\u91CC\u9762\u7684 BNB\uFF0C\u5DF2\u505C\u6B62\u8FD0\u884C\uFF0C\u8BF7\u8054\u7CFB\u5F00\u53D1\u8005\u5904\u7406\u3002");
  }
  const hex = toHex(utils.randomSecretKey());
  await env.STATE.put(KEY_SLOT, hex);
  const k = keyFromString(hex, "\u65B0\u5EFA\u7684\u68C0\u67E5\u94B1\u5305");
  s.generatedAddr = k.addr;
  s.generatedAt = Math.floor(Date.now() / 1e3);
  return k;
}
var label = (k) => k === "settle" ? "\u7ED3\u7B97" : "\u68C0\u67E5";
var autoSettleHours = (n) => Math.min(24, Math.max(1, n / 20));
async function runOnce(env) {
  const c = config(env);
  const loaded = await loadState(env, c);
  const s = loaded.s;
  const st = {
    at: 0,
    head: 0,
    ok: false,
    actions: [],
    errors: [],
    accruing: null,
    reasons: null,
    lastCheckpoint: null,
    keeper: null,
    balance: null,
    gasPrice: null,
    users: Object.keys(s.users).length,
    toSettle: settleList(s).length,
    settleHours: null
  };
  if (!loaded.ok) st.errors.push(loaded.why);
  if (loaded.ok && s.busy) {
    s.load = Math.max(0.25, (s.load || 1) / 2);
    st.errors.push("\u4E0A\u6B21\u8FD0\u884C\u4E2D\u9014\u88AB\u4E2D\u65AD\uFF08\u53EF\u80FD\u662F CPU \u8D85\u65F6\uFF09\uFF0C\u5DF2\u81EA\u52A8\u51CF\u5C11\u6BCF\u6B21\u7684\u5DE5\u4F5C\u91CF");
  }
  const load = loaded.ok && s.load || 1;
  const rpc = new Rpc(c.rpcs, SUBREQUEST_BUDGET);
  const fingerprint = (x) => {
    const t = x.status || {};
    return JSON.stringify({
      ...x,
      scanned: 0,
      // re-reading a few blocks next run is harmless; new users change `users` and force a write
      okAt: 0,
      savedAt: 0,
      seq: 0,
      load: Math.round((x.load || 1) * 4),
      status: { ok: t.ok, errors: t.errors, actions: t.actions, accruing: t.accruing, reasons: t.reasons, keeper: t.keeper, users: t.users, toSettle: t.toSettle }
    });
  };
  const fp0 = loaded.ok ? fingerprint(s) : null;
  const save = async (busy, force = false) => {
    if (!loaded.ok) return;
    s.busy = busy;
    s.status = st;
    const nowS = Math.floor(Date.now() / 1e3);
    if (force || fingerprint(s) !== fp0 || nowS - (s.savedAt || 0) >= 600) {
      s.savedAt = nowS;
      s.seq = (s.seq || 0) + 1;
      try {
        await env.STATE.put("state", JSON.stringify(s));
      } catch (e) {
        st.errors.push("\u4FDD\u5B58 KV \u5931\u8D25\uFF1A" + (e?.message || e));
      }
    }
    memState = JSON.parse(JSON.stringify(s));
  };
  try {
    const { key, addr: me } = await resolveKey(env, loaded, s);
    st.keeper = me;
    s.keeperAddr = me;
    const ethCall = (data, from) => ["eth_call", [from ? { from, to: c.miner, data } : { to: c.miner, data }, "latest"]];
    const r = await rpc.batch([
      ["eth_chainId", []],
      ["eth_getBlockByNumber", ["latest", false]],
      ["eth_gasPrice", []],
      ["eth_getTransactionCount", [me, "latest"]],
      ["eth_getTransactionCount", [me, "pending"]],
      ["eth_getBalance", [me, "latest"]],
      ethCall("0x" + SEL.accruing),
      ethCall("0x" + SEL.pauseReasons),
      ethCall("0x" + SEL.lastCheckpointTime),
      ethCall("0x" + SEL.checkpoint, me),
      ethCall("0x" + SEL.operator),
      ethCall("0x" + SEL.owner)
    ]);
    const need = (i, what) => {
      if (r[i].error) throw new Error(`\u8BFB\u53D6${what}\u5931\u8D25\uFF1A${r[i].error.message}`);
      return r[i].result;
    };
    const chainId = Number(need(0, "\u94FE ID"));
    if (chainId !== c.chainId) throw new Error(`\u8FDE\u63A5\u7684\u4E0D\u662F\u6B63\u786E\u7684\u94FE\uFF08\u94FE ID ${chainId}\uFF0C\u5E94\u4E3A ${c.chainId}\uFF09`);
    const blk = need(1, "\u6700\u65B0\u533A\u5757");
    const head = Number(blk.number);
    const now = Number(blk.timestamp);
    st.at = now;
    st.head = head;
    const operator = "0x" + String(need(10, "\u8FD0\u8425\u94B1\u5305\u5730\u5740")).slice(-40).toLowerCase();
    const owner = "0x" + String(need(11, "\u7BA1\u7406\u5458\u5730\u5740")).slice(-40).toLowerCase();
    if (me === operator || me === owner) {
      throw new Error("KEEPER_KEY \u586B\u7684\u662F\u8FD0\u8425/\u7BA1\u7406\u5458\u94B1\u5305\u7684\u79C1\u94A5\uFF01\u5DF2\u62D2\u7EDD\u8FD0\u884C\u3002\u8BF7\u7ACB\u523B\u5220\u9664\u8FD9\u4E2A\u5BC6\u94A5\uFF0C\u6362\u4E00\u4E2A\u5168\u65B0\u7684\u94B1\u5305\uFF0C\u5E76\u628A\u8FD0\u8425\u94B1\u5305\u7684\u8D44\u4EA7\u8F6C\u5230\u5B89\u5168\u7684\u65B0\u94B1\u5305\u3002");
    }
    if (!r[8].error && (r[8].result === "0x" || !r[8].result)) throw new Error("MINER \u5730\u5740\u4E0D\u662F\u6316\u77FF\u5408\u7EA6\uFF0C\u8BF7\u68C0\u67E5\u5408\u7EA6\u5730\u5740");
    let gasPrice = big2(need(2, "\u624B\u7EED\u8D39\u4EF7\u683C"));
    const nonceLatest = Number(need(3, "\u4EA4\u6613\u5E8F\u53F7"));
    const noncePending = Number(need(4, "\u4EA4\u6613\u5E8F\u53F7"));
    const balance = big2(need(5, "BNB \u4F59\u989D"));
    const accruing = big2(need(6, "\u8FD0\u884C\u72B6\u6001")) !== 0n;
    const reasons = Number(big2(need(7, "\u6682\u505C\u539F\u56E0")));
    const lastCp = Number(big2(need(8, "\u4E0A\u6B21\u68C0\u67E5\u65F6\u95F4")));
    st.balance = balance.toString();
    st.accruing = accruing;
    st.reasons = reasons;
    st.lastCheckpoint = lastCp;
    const still = [];
    for (const t of s.pending || []) {
      if (typeof t.nonce !== "number" || nonceLatest > t.nonce) continue;
      if (now - t.at < 1800) still.push(t);
      else st.errors.push(`\u4EA4\u6613\u957F\u65F6\u95F4\u672A\u786E\u8BA4\uFF1A${t.hash}`);
    }
    s.pending = still;
    const floor = 50000000n;
    if (gasPrice < floor) gasPrice = floor;
    if (gasPrice > c.maxGasWei) gasPrice = c.maxGasWei;
    let nonce = noncePending;
    let spendable = balance;
    const sendTxs = async (txs) => {
      if (!txs.length) return [];
      const est = await rpc.batch(txs.map((t) => ["eth_estimateGas", [{ from: me, to: t.to, data: t.data }]]));
      const ready = [];
      for (let i = 0; i < txs.length; i++) {
        const t = txs[i];
        if (est[i].error) {
          st.errors.push(`${label(t.kind)}\u4EA4\u6613\u9884\u4F30\u5931\u8D25\uFF1A${est[i].error.message}`);
          break;
        }
        const gas = big2(est[i].result) * 13n / 10n + 15000n;
        if (gas * gasPrice > spendable) {
          st.errors.push(`\u68C0\u67E5\u94B1\u5305\u7684 BNB \u4E0D\u591F\u4ED8\u624B\u7EED\u8D39\uFF0C\u8BF7\u5F80 ${me} \u8F6C 0.01 BNB`);
          break;
        }
        spendable -= gas * gasPrice;
        ready.push({ ...t, gas });
      }
      if (!ready.length) return [];
      const signed = ready.map((t) => {
        const n = nonce++;
        const tx = { nonce: n, gasPrice, gasLimit: t.gas, to: t.to, value: 0, data: t.data, chainId: c.chainId };
        return { ...t, nonce: n, ...signLegacyTx(tx, key) };
      });
      const res = await rpc.batch(signed.map((t) => ["eth_sendRawTransaction", [t.raw]]));
      const out = [];
      for (let i = 0; i < signed.length; i++) {
        const t = signed[i];
        const e = res[i].error;
        if (e && !/already known|known transaction/i.test(e.message || "")) {
          st.errors.push(`\u53D1\u9001${label(t.kind)}\u4EA4\u6613\u5931\u8D25\uFF1A${e.message}`);
          break;
        }
        s.pending.push({ hash: t.hash, kind: t.kind, at: now, nonce: t.nonce });
        out.push(t);
      }
      if (out.length) {
        s.lastSentAt = now;
        s.lastGasPrice = gasPrice.toString();
      }
      s.pending = s.pending.slice(-8);
      return out;
    };
    let wouldRun = null;
    if (r[9].error) st.errors.push("\u68C0\u67E5\u8C03\u7528\u4F1A\u5931\u8D25\uFF1A" + r[9].error.message);
    else wouldRun = big2(r[9].result) !== 0n;
    const stuck = noncePending > nonceLatest && now - (s.lastSentAt || 0) > 300;
    let cpTx = null;
    if (stuck) {
      nonce = nonceLatest;
      const last = BigInt(s.lastGasPrice || "0");
      gasPrice = (gasPrice > last ? gasPrice : last) * 2n;
      if (gasPrice > c.maxGasWei) gasPrice = c.maxGasWei;
      st.actions.push("\u53D1\u73B0\u5361\u4F4F\u7684\u4EA4\u6613\uFF0C\u63D0\u9AD8\u624B\u7EED\u8D39\u91CD\u65B0\u53D1\u9001");
      const tx = wouldRun !== null ? { kind: "checkpoint", to: c.miner, data: "0x" + SEL.checkpoint } : { kind: "replace", to: me, data: "0x" };
      cpTx = (await sendTxs([tx])).find((t) => t.kind === "checkpoint") || null;
    } else if (wouldRun !== null && (now - lastCp >= c.checkMinutes * 60 || wouldRun !== accruing)) {
      cpTx = (await sendTxs([{ kind: "checkpoint", to: c.miner, data: "0x" + SEL.checkpoint }]))[0] || null;
    }
    if (cpTx) {
      s.lastCheckpointTx = { hash: cpTx.hash, at: now };
      if (wouldRun !== accruing) st.actions.push(wouldRun ? "\u6761\u4EF6\u5DF2\u6062\u590D\uFF0C\u6062\u590D\u8BA1\u606F" : "\u6761\u4EF6\u4E0D\u6EE1\u8DB3\uFF0C\u6682\u505C\u8BA1\u606F");
      st.actions.push(`\u66F4\u65B0\u4EF7\u683C\u5E76\u68C0\u67E5\uFF1A${cpTx.hash}`);
      st.lastCheckpoint = now;
      if (wouldRun !== accruing) st.reasons = wouldRun ? 0 : null;
      st.accruing = wouldRun;
    }
    st.gasPrice = gasPrice.toString();
    if (loaded.ok && !stuck) {
      try {
        const to = head - c.confirmations;
        const maxCalls = Math.max(1, Math.round(c.maxLogCalls * load));
        if (!s.chunk || s.chunk > c.logChunk) s.chunk = c.logChunk;
        const order = [...c.logRpcs].sort((a, b) => a === s.logsUrl ? -1 : b === s.logsUrl ? 1 : 0);
        const getLogs = async (from, end) => {
          const fails = [];
          for (const url of order) {
            if (rpc.left <= 6) break;
            try {
              const j = await rpc.post(url, {
                jsonrpc: "2.0",
                id: rpc.id++,
                method: "eth_getLogs",
                params: [{ address: c.miner, fromBlock: qty(from), toBlock: qty(end), topics: [[T_JOINED, T_DEPOSITED, T_WITHDRAWN]] }]
              });
              if (j && Array.isArray(j.result)) {
                s.logsUrl = url;
                return j.result;
              }
              fails.push(`${new URL(url).hostname}: ${String(j?.error?.message || "\u65E0\u7ED3\u679C").slice(0, 60)}`);
            } catch (e) {
              fails.push(`${new URL(url).hostname}: ${String(e?.message || e).slice(0, 60)}`);
            }
          }
          const err = new Error(fails.join("\uFF1B") || "\u7F51\u7EDC\u8BF7\u6C42\u6B21\u6570\u7528\u5B8C");
          err.fails = fails.length;
          throw err;
        };
        let calls = 0;
        while (s.scanned < to && calls < maxCalls && rpc.left > 6) {
          const from = s.scanned + 1;
          const end = Math.min(to, from + s.chunk - 1);
          calls++;
          let logs;
          try {
            logs = await getLogs(from, end);
          } catch (e) {
            if (s.chunk > 50) {
              s.chunk = Math.max(50, Math.floor(s.chunk / 4));
              throw new Error("\u6240\u6709\u8282\u70B9\u90FD\u62D2\u7EDD\u4E86\u8FD9\u6B21\u67E5\u8BE2\uFF0C\u4E0B\u6B21\u7528\u66F4\u5C0F\u7684\u8303\u56F4\u91CD\u8BD5\uFF08" + e.message + "\uFF09");
            }
            throw e;
          }
          for (const l of logs) applyLog(s.users, l);
          s.scanned = end;
        }
        if (s.scanned < to) st.actions.push(`\u6B63\u5728\u8BFB\u53D6\u5386\u53F2\u8BB0\u5F55\uFF08\u8FD8\u5DEE\u7EA6 ${to - s.scanned} \u4E2A\u533A\u5757\uFF09`);
      } catch (e) {
        st.errors.push("\u8BFB\u53D6\u7528\u6237\u8BB0\u5F55\u5931\u8D25\uFF1A" + (e?.message || e));
      }
      const list = settleList(s);
      st.users = Object.keys(s.users).length;
      st.toSettle = list.length;
      const hours = c.settleHours ?? autoSettleHours(list.length);
      st.settleHours = hours;
      const due = now - (s.lastSettle || 0) >= hours * 3600 || (s.settleCursor || 0) > 0;
      if (due && list.length === 0) s.settleCursor = 0;
      else if (due && rpc.left >= 2) {
        const batch = Math.max(10, Math.round(c.batch * load));
        const maxTx = Math.max(1, Math.round(c.maxSettleTx * load));
        let i = s.settleCursor || 0;
        if (i >= list.length) i = 0;
        const txs = [];
        for (let j = i; j < list.length && txs.length < maxTx; j += batch) {
          const part = list.slice(j, j + batch);
          txs.push({ kind: "settle", to: c.miner, data: encodeSettleMany(part), count: part.length });
        }
        if (txs.length) await save({ at: now }, true);
        const sent = await sendTxs(txs);
        for (const t of sent) {
          i += t.count;
          st.actions.push(`\u7ED3\u7B97\u63A8\u8350\u5956\u52B1 ${t.count} \u4E2A\u94B1\u5305\uFF1A${t.hash}`);
        }
        if (i >= list.length) {
          s.settleCursor = 0;
          s.lastSettle = now;
          s.lastSettleTx = { hash: sent[sent.length - 1].hash, at: now, count: list.length };
        } else s.settleCursor = i;
      }
    }
    const h = s.balHist || (s.balHist = []);
    if (!h.length || now - h[h.length - 1].t >= 6 * 3600) {
      h.push({ t: now, b: balance.toString() });
      if (h.length > 13) h.splice(0, h.length - 13);
    }
  } catch (e) {
    st.errors.push(e?.message || String(e));
  }
  if (!st.at) st.at = Math.floor(Date.now() / 1e3);
  st.ok = st.errors.length === 0;
  if (st.ok) {
    s.okAt = st.at;
    s.load = Math.min(1, load + 0.02);
  }
  s.status = st;
  await save(null);
  console.log(`ok=${st.ok} running=${st.accruing} ${st.actions.join(" | ")} ${st.errors.join(" | ")}`);
  return s;
}
var esc = (x) => String(x).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
var bj = (t) => t ? new Date((t + 8 * 3600) * 1e3).toISOString().slice(0, 16).replace("T", " ") : "\u2014";
var ago = (now, t) => {
  if (!t) return "";
  const m = Math.max(0, Math.round((now - t) / 60));
  return m < 60 ? `\uFF08${m} \u5206\u949F\u524D\uFF09` : m < 2880 ? `\uFF08${Math.round(m / 60)} \u5C0F\u65F6\u524D\uFF09` : `\uFF08${Math.round(m / 1440)} \u5929\u524D\uFF09`;
};
var bnb = (wei) => {
  if (wei === null || wei === void 0) return "\u2014";
  const v = Number(BigInt(wei) / 10n ** 12n) / 1e6;
  return v.toFixed(4) + " BNB";
};
function daysLeft(s) {
  const h = s.balHist || [];
  if (h.length < 2) return null;
  const a = h[0];
  const b = h[h.length - 1];
  const spent = BigInt(a.b) - BigInt(b.b);
  const dt = b.t - a.t;
  if (dt < 6 * 3600 || spent <= 0n) return null;
  const perDay = Number(spent) / dt * 86400;
  return Number(BigInt(b.b)) / perDay;
}
function statusPage(s, env) {
  const c = config(env);
  const nowS = Math.floor(Date.now() / 1e3);
  const st = s?.status;
  const rows = [];
  const row = (k, v) => rows.push(`<div class="row"><span>${esc(k)}</span><b>${v}</b></div>`);
  let pill = ["wait", "\u8FD8\u6CA1\u6709\u8FD0\u884C\u8FC7"];
  const hints = [];
  if (!env.STATE) hints.push("\u8FD8\u6CA1\u6709\u7ED1\u5B9A KV \u5B58\u50A8\uFF0C\u53D8\u91CF\u540D\u5FC5\u987B\u662F STATE\u3002");
  if (st?.keeper && st.balance !== null && BigInt(st.balance) < 3n * 10n ** 15n)
    hints.push(`\u8BF7\u5F80\u68C0\u67E5\u94B1\u5305 ${st.keeper} \u8F6C 0.01 BNB \u4F5C\u4E3A\u624B\u7EED\u8D39\uFF08\u53EA\u80FD\u8F6C BSC \u94FE\u4E0A\u7684 BNB\uFF09\uFF0C\u8F6C\u5165\u540E 1 \u5206\u949F\u5185\u81EA\u52A8\u5F00\u59CB\u5DE5\u4F5C\u3002`);
  if (st) {
    const fresh = nowS - st.at < 30 * 60;
    pill = st.ok && fresh ? ["ok", "\u6B63\u5E38\u8FD0\u884C"] : fresh ? ["warn", "\u6709\u95EE\u9898\uFF0C\u89C1\u4E0B\u65B9"] : ["warn", "\u8D85\u8FC7 30 \u5206\u949F\u6CA1\u6709\u8FD0\u884C"];
    row("\u6700\u8FD1\u4E00\u6B21\u8FD0\u884C\uFF08\u5317\u4EAC\u65F6\u95F4\uFF09", esc(bj(st.at)) + esc(ago(nowS, st.at)));
    if (st.accruing !== null) {
      const why = st.reasons === null ? ["\u539F\u56E0\u4E0B\u4E00\u6B21\u8FD0\u884C\u65F6\u663E\u793A"] : REASONS.filter(([b]) => st.reasons & b).map(([, t]) => t);
      row("\u5408\u7EA6\u72B6\u6001", st.accruing ? '<i class="g">\u8FD0\u884C\u4E2D\uFF0C\u6B63\u5E38\u8BA1\u606F</i>' : `<i class="r">\u5DF2\u6682\u505C</i>${why.length ? "\uFF1A" + esc(why.join("\uFF1B")) : ""}`);
      row("\u5408\u7EA6\u4E0A\u6B21\u66F4\u65B0\u4EF7\u683C", esc(bj(st.lastCheckpoint)) + esc(ago(nowS, st.lastCheckpoint)));
    }
    row(
      "\u63A8\u8350\u5956\u52B1\u4E0A\u6B21\u7ED3\u7B97",
      s.lastSettleTx?.at ? esc(bj(s.lastSettleTx.at)) + esc(ago(nowS, s.lastSettleTx.at)) + `\uFF0C${s.lastSettleTx.count} \u4E2A\u94B1\u5305` : "\u8FD8\u6CA1\u6709\u7ED3\u7B97\u8FC7"
    );
    row(
      "\u5DF2\u53D1\u73B0\u7684\u94B1\u5305",
      `${st.users} \u4E2A\uFF08\u5176\u4E2D ${st.toSettle} \u4E2A\u6709\u63A8\u8350\u4EBA\u4E14\u6709\u672C\u91D1\uFF0C\u9700\u8981\u5B9A\u671F\u7ED3\u7B97\uFF09` + (st.settleHours ? `<br>\u63A8\u8350\u5956\u52B1\u7EA6\u6BCF ${esc(Math.round(st.settleHours * 10) / 10)} \u5C0F\u65F6\u81EA\u52A8\u7ED3\u7B97\u4E00\u6B21` : "")
    );
    if (st.keeper) {
      row("\u68C0\u67E5\u94B1\u5305", `<a href="${esc(c.explorer)}/address/${esc(st.keeper)}" target="_blank">${esc(st.keeper.slice(0, 8) + "\u2026" + st.keeper.slice(-6))}</a>`);
      const low = st.balance !== null && BigInt(st.balance) < 3n * 10n ** 15n;
      const d = daysLeft(s);
      row(
        "\u68C0\u67E5\u94B1\u5305\u4F59\u989D",
        (low ? '<i class="r">' : "") + esc(bnb(st.balance)) + (low ? "\uFF08\u5FEB\u7528\u5B8C\u4E86\uFF0C\u8BF7\u8865\u5145\uFF09</i>" : "") + (d !== null ? `\uFF0C\u6309\u6700\u8FD1\u6D88\u8017\u7EA6\u8FD8\u80FD\u7528 ${esc(Math.floor(d))} \u5929` : "\uFF0C\u8FD0\u884C\u534A\u5929\u540E\u663E\u793A\u8FD8\u80FD\u7528\u51E0\u5929")
      );
    }
    const link = (t) => esc(t).replace(/0x[0-9a-fA-F]{64}/g, (h) => `<a href="${esc(c.explorer)}/tx/${h}" target="_blank">${h.slice(0, 10)}\u2026</a>`);
    if (st.actions.length) row("\u8FD9\u6B21\u505A\u4E86\u4EC0\u4E48", st.actions.map(link).join("<br>"));
    if (st.errors.length) row("\u95EE\u9898", `<i class="r">${st.errors.map((a) => esc(a)).join("<br>")}</i>`);
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>\u559C\u7F8A\u7F8A\u77FF\u573A \xB7 \u81EA\u52A8\u68C0\u67E5\u670D\u52A1</title><style>
body{margin:0;font:16px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f3f7f4;color:#17301f}
.w{max-width:560px;margin:0 auto;padding:20px 16px 40px}h1{font-size:21px;margin:4px 0 14px}
.pill{display:inline-block;padding:6px 14px;border-radius:999px;font-weight:700;margin-bottom:14px}
.ok{background:#d9f5e1;color:#127a39}.warn{background:#fff0d6;color:#9a5b00}.wait{background:#e8ecef;color:#4b5a63}
.card{background:#fff;border-radius:14px;padding:6px 16px;box-shadow:0 1px 3px #0001}
.row{display:flex;flex-direction:column;padding:11px 0;border-bottom:1px solid #eef2ef}.row:last-child{border:0}
.row span{font-size:13px;color:#6b7c72}.row b{font-weight:600;word-break:break-all}
i{font-style:normal}.g{color:#127a39}.r{color:#c0392b}.hint{background:#fff7e6;border-radius:12px;padding:10px 14px;margin-bottom:12px}
a{color:#1769aa}.foot{font-size:13px;color:#6b7c72;margin-top:14px}</style></head><body><div class="w">
<h1>\u559C\u7F8A\u7F8A\u77FF\u573A \xB7 \u81EA\u52A8\u68C0\u67E5\u670D\u52A1</h1><div class="pill ${pill[0]}">${pill[1]}</div>
${hints.map((h) => `<div class="hint">${esc(h)}</div>`).join("")}
<div class="card">${rows.join("") || '<div class="row"><b>\u7B2C\u4E00\u6B21\u8FD0\u884C\u4F1A\u81EA\u52A8\u521B\u5EFA\u68C0\u67E5\u94B1\u5305\uFF0C1 \u5206\u949F\u5DE6\u53F3\u5C31\u4F1A\u663E\u793A\u7ED3\u679C\u3002</b></div>'}</div>
<p class="foot">\u8FD9\u4E2A\u9875\u9762\u53EA\u663E\u793A\u72B6\u6001\uFF0C\u4E0D\u80FD\u64CD\u4F5C\u4EFB\u4F55\u4E1C\u897F\u3002\u6BCF\u5206\u949F\u81EA\u52A8\u8FD0\u884C\u4E00\u6B21\uFF08\u72B6\u6001\u6BCF 10 \u5206\u949F\u6216\u6709\u53D8\u5316\u65F6\u66F4\u65B0\uFF09\u3002</p></div></body></html>`;
}
{
  const k = new Uint8Array(32);
  k[31] = 7;
  const me = addressOf(k);
  const list = Array.from({ length: 60 }, (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0"));
  const data = encodeSettleMany(list);
  for (let i = 0; i < 40; i++) {
    signLegacyTx({ nonce: i, gasPrice: 50000000n, gasLimit: 3000000n + BigInt(i), to: me, data: i % 2 ? data : "0x" + SEL.checkpoint, chainId: 56 }, k);
  }
  const d = new Uint8Array(2048);
  for (let i = 0; i < 400; i++) keccak_256(d.subarray(0, 32 + i % 16 * 128));
  const users = {};
  const log = { topics: [T_DEPOSITED, "0x" + word(1), "0x" + word(1)], data: "0x" + word(123) + word(0).repeat(6) };
  for (let i = 0; i < 300; i++) applyLog(users, { ...log, topics: [log.topics[0], "0x" + word(i + 1), log.topics[2]] });
  JSON.parse(JSON.stringify(users));
  settleList({ users });
}
var VERIFY = {
  address: "0x363CBA25a4bC4617fAF017b1e0728f4AB7473E17",
  creationTx: "0x299eedb51a8be6cfd6291a8a37aac56dbc72ba578be9c3793212eedecb74d79a",
  input: "https://raw.githubusercontent.com/fengjinchehu91/pop-xiyangyang/main/contracts/verify/XiyangMiner-standard-input.json",
  args: "https://raw.githubusercontent.com/fengjinchehu91/pop-xiyangyang/main/contracts/verify/constructor-args.txt",
  name: "src/XiyangMiner.sol:XiyangMiner",
  compiler: "0.8.26+commit.8a97fa7a"
};
async function verifyContract(url) {
  const t = async (r) => `HTTP ${r.status} ${(await r.text()).slice(0, 600)}`;
  const id = url.searchParams.get("id");
  const key = url.searchParams.get("k");
  const guid = url.searchParams.get("guid");
  if (url.pathname.endsWith("/sourcify")) {
    if (id) return t(await fetch(`https://sourcify.dev/server/v2/verify/${id}`));
    const input2 = await (await fetch(VERIFY.input)).json();
    return t(
      await fetch(`https://sourcify.dev/server/v2/verify/56/${VERIFY.address}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stdJsonInput: input2, compilerVersion: VERIFY.compiler, contractIdentifier: VERIFY.name, creationTransactionHash: VERIFY.creationTx })
      })
    );
  }
  if (!key) return "missing key";
  const api = "https://api.etherscan.io/v2/api?chainid=56";
  if (guid) return t(await fetch(`${api}&module=contract&action=checkverifystatus&guid=${encodeURIComponent(guid)}&apikey=${encodeURIComponent(key)}`));
  const [input, args] = await Promise.all([fetch(VERIFY.input).then((r) => r.text()), fetch(VERIFY.args).then((r) => r.text())]);
  const form = new URLSearchParams({
    module: "contract",
    action: "verifysourcecode",
    apikey: key,
    contractaddress: VERIFY.address,
    sourceCode: input,
    codeformat: "solidity-standard-json-input",
    contractname: VERIFY.name,
    compilerversion: "v" + VERIFY.compiler,
    constructorArguements: args.trim(),
    licenseType: "4"
  });
  return t(await fetch(`${api}&module=contract&action=verifysourcecode`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form }));
}
async function diag(env) {
  const c = config(env);
  const rpc = new Rpc(c.rpcs, 6);
  const call = (to, sig, args = "") => ["eth_call", [{ to, data: "0x" + selector(sig) + args }, "latest"]];
  const m = c.miner;
  const names = ["POOL()", "REWARD_POOL()", "REWARD_V2()", "REWARD_VIA_POP()", "TWAP_WINDOW()", "MAX_VALUATION_AGE()", "minPoolLiquidity()", "minRewardPoolLiquidity()", "maxTickDeviation()", "obsCount()", "obsNext()", "lastValuationTime()", "valuePerRef()", "rewardPriceView()", "pauseReasons()", "accruing()", "lastCheckpointTime()", "TOKEN0()", "POP()", "USDT()", "REWARD()"];
  const r1 = await rpc.batch([["eth_getBlockByNumber", ["latest", false]], ...names.map((n) => call(m, n))]);
  const out = { now: Number(r1[0].result?.timestamp), miner: {} };
  names.forEach((n, i) => out.miner[n] = r1[i + 1].result ?? r1[i + 1].error?.message);
  const pool = "0x" + String(out.miner["POOL()"]).slice(-40);
  const rp = "0x" + String(out.miner["REWARD_POOL()"]).slice(-40);
  const tw = Number(big2(out.miner["TWAP_WINDOW()"]));
  const obsArgs = word(32) + word(2) + word(tw) + word(0);
  const q = [
    call(pool, "slot0()"),
    call(pool, "liquidity()"),
    call(pool, "observe(uint32[])", obsArgs),
    call(pool, "token0()"),
    call(pool, "token1()"),
    call(pool, "fee()"),
    call(rp, "getReserves()"),
    call(rp, "token0()"),
    call(rp, "token1()"),
    call(rp, "price0CumulativeLast()"),
    call(rp, "price1CumulativeLast()")
  ];
  const r2 = await rpc.batch(q);
  const keys = ["slot0", "liquidity", "observe", "token0", "token1", "fee", "rp.getReserves", "rp.token0", "rp.token1", "rp.p0cum", "rp.p1cum"];
  out.pool = {};
  keys.forEach((k, i) => out.pool[k] = r2[i].result ?? "ERR " + (r2[i].error?.message || "") + " " + (r2[i].error?.data || ""));
  return out;
}
function statusJson(s) {
  const st = s?.status || null;
  return {
    ran: !!st,
    at: st?.at ?? null,
    ok: st?.ok ?? false,
    okAt: s?.okAt ?? null,
    accruing: st?.accruing ?? null,
    reasons: st?.reasons ?? null,
    lastCheckpoint: st?.lastCheckpoint ?? null,
    keeper: st?.keeper || s?.keeperAddr || null,
    balance: st?.balance ?? null,
    lowBalance: st?.balance != null ? BigInt(st.balance) < 3n * 10n ** 15n : null,
    daysLeft: s ? daysLeft(s) : null,
    users: st?.users ?? 0,
    toSettle: st?.toSettle ?? 0,
    settleHours: st?.settleHours ?? null,
    lastSettle: s?.lastSettleTx?.at ?? null,
    actions: st?.actions ?? [],
    errors: st?.errors ?? []
  };
}
var pageMemo = { t: 0, s: null };
var worker_default = {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOnce(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    if (p === "/keeper/diag") {
      let body;
      try {
        body = JSON.stringify(await diag(env), null, 1);
      } catch (e) {
        body = "error " + (e?.message || e);
      }
      return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }
    if (p === "/keeper/verify/sourcify" || p === "/keeper/verify/bscscan") {
      let body;
      try {
        body = await verifyContract(url);
      } catch (e) {
        body = "error " + (e?.message || e);
      }
      return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    if (p !== "/" && p !== "/keeper" && p !== "/keeper.json") return new Response("Not found", { status: 404 });
    let s = pageMemo.s;
    if (Date.now() - pageMemo.t > 2e4) {
      try {
        s = env.STATE ? await env.STATE.get("state", "json") : null;
      } catch {
        s = null;
      }
      if (s) pageMemo = { t: Date.now(), s };
    }
    if (p === "/keeper.json") {
      const out = statusJson(s);
      if (out.keeper) {
        try {
          const c = config(env);
          const r = await new Rpc(c.rpcs, 3).batch([
            ["eth_getBalance", [out.keeper, "latest"]],
            ["eth_getTransactionCount", [out.keeper, "latest"]]
          ]);
          if (r[0].result) {
            out.balanceNow = BigInt(r[0].result).toString();
            out.balance = out.balanceNow;
            out.lowBalance = BigInt(out.balanceNow) < 3n * 10n ** 15n;
          }
          if (r[1].result) out.txCount = Number(r[1].result);
        } catch {
        }
      }
      return new Response(JSON.stringify(out), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
      });
    }
    return new Response(statusPage(s, env), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
    });
  }
};
var __test = { SEL, T_JOINED, T_DEPOSITED, T_WITHDRAWN };
export {
  __test,
  addressOf,
  autoSettleHours,
  worker_default as default,
  encodeSettleMany,
  runOnce,
  signLegacyTx,
  statusJson,
  statusPage
};
