const encoder=new TextEncoder();

/** @param {string|Uint8Array|ArrayBuffer} input @returns {Uint8Array} */
function toBytes(input) {
  if(typeof input==='string')return encoder.encode(input);
  if(input instanceof Uint8Array)return input;
  return new Uint8Array(input);
}

/** @param {number} value @param {number} shift */
const rotl=(value,shift)=>(value<<shift)|(value>>>(32-shift));
/** @param {number} value @param {number} shift */
const rotr=(value,shift)=>(value>>>shift)|(value<<(32-shift));

/** @param {Uint32Array} words */
function toHex(words) {
  let out='';
  for(let i=0;i<words.length;i++)out+=(words[i]>>>0).toString(16).padStart(8,'0');
  return out;
}

/** @param {Uint8Array[]} parts */
function concatBytes(parts) {
  if(parts.length===1)return parts[0];
  let total=0;
  for(const part of parts)total+=part.length;
  const out=new Uint8Array(total);
  let offset=0;
  for(const part of parts){out.set(part,offset);offset+=part.length;}
  return out;
}

/** @param {...(string|Uint8Array|ArrayBuffer)} inputs @returns {string} */
export function sha1(...inputs) {
  const bytes=concatBytes(inputs.map(toBytes));
  const length=bytes.length;
  const paddedLength=((length+9+63)&~63);
  const buffer=new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[length]=0x80;
  const view=new DataView(buffer.buffer);
  const bitLenHi=Math.floor(length/0x20000000);
  const bitLenLo=(length<<3)>>>0;
  view.setUint32(paddedLength-8,bitLenHi,false);
  view.setUint32(paddedLength-4,bitLenLo,false);

  const state=new Uint32Array([0x67452301,0xefcdab89,0x98badcfe,0x10325476,0xc3d2e1f0]);
  const w=new Uint32Array(80);
  for(let offset=0;offset<paddedLength;offset+=64){
    for(let i=0;i<16;i++)w[i]=view.getUint32(offset+i*4,false);
    for(let i=16;i<80;i++)w[i]=rotl(w[i-3]^w[i-8]^w[i-14]^w[i-16],1);
    let a=state[0],b=state[1],c=state[2],d=state[3],e=state[4];
    for(let i=0;i<80;i++){
      let f,k;
      if(i<20){f=(b&c)|((~b)&d);k=0x5a827999;}
      else if(i<40){f=b^c^d;k=0x6ed9eba1;}
      else if(i<60){f=(b&c)|(b&d)|(c&d);k=0x8f1bbcdc;}
      else {f=b^c^d;k=0xca62c1d6;}
      const temp=(rotl(a,5)+f+e+k+w[i])|0;
      e=d;d=c;c=rotl(b,30);b=a;a=temp;
    }
    state[0]=(state[0]+a)|0;
    state[1]=(state[1]+b)|0;
    state[2]=(state[2]+c)|0;
    state[3]=(state[3]+d)|0;
    state[4]=(state[4]+e)|0;
  }
  return toHex(state);
}

const K256=new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);

/** @param {...(string|Uint8Array|ArrayBuffer)} inputs @returns {string} */
export function sha256(...inputs) {
  const bytes=concatBytes(inputs.map(toBytes));
  const length=bytes.length;
  const paddedLength=((length+9+63)&~63);
  const buffer=new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[length]=0x80;
  const view=new DataView(buffer.buffer);
  const bitLenHi=Math.floor(length/0x20000000);
  const bitLenLo=(length<<3)>>>0;
  view.setUint32(paddedLength-8,bitLenHi,false);
  view.setUint32(paddedLength-4,bitLenLo,false);

  const state=new Uint32Array([
    0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
    0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19
  ]);
  const w=new Uint32Array(64);
  for(let offset=0;offset<paddedLength;offset+=64){
    for(let i=0;i<16;i++)w[i]=view.getUint32(offset+i*4,false);
    for(let i=16;i<64;i++){
      const s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3);
      const s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);
      w[i]=(w[i-16]+s0+w[i-7]+s1)|0;
    }
    let a=state[0],b=state[1],c=state[2],d=state[3],e=state[4],f=state[5],g=state[6],h=state[7];
    for(let i=0;i<64;i++){
      const s1=rotr(e,6)^rotr(e,11)^rotr(e,25);
      const ch=(e&f)^((~e)&g);
      const t1=(h+s1+ch+K256[i]+w[i])|0;
      const s0=rotr(a,2)^rotr(a,13)^rotr(a,22);
      const maj=(a&b)^(a&c)^(b&c);
      const t2=(s0+maj)|0;
      h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
    }
    state[0]=(state[0]+a)|0;state[1]=(state[1]+b)|0;state[2]=(state[2]+c)|0;state[3]=(state[3]+d)|0;
    state[4]=(state[4]+e)|0;state[5]=(state[5]+f)|0;state[6]=(state[6]+g)|0;state[7]=(state[7]+h)|0;
  }
  return toHex(state);
}

/** @param {string} hex @returns {Uint8Array} */
function hexToBytes(hex) {
  const out=new Uint8Array(hex.length/2);
  for(let i=0;i<out.length;i++)out[i]=parseInt(hex.slice(i*2,i*2+2),16);
  return out;
}

/** @param {Uint8Array|string} key @param {...(string|Uint8Array|ArrayBuffer)} inputs @returns {string} */
export function hmacSha256(key,...inputs) {
  const raw=typeof key==='string'?toBytes(key):key;
  const block=new Uint8Array(64);
  block.set(raw.length>64?hexToBytes(sha256(raw)):raw);
  const ipad=new Uint8Array(64),opad=new Uint8Array(64);
  for(let i=0;i<64;i++){ipad[i]=block[i]^0x36;opad[i]=block[i]^0x5c;}
  const inner=hexToBytes(sha256(ipad,...inputs));
  return sha256(opad,inner);
}
