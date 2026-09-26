import { describe, expect, it } from "vitest";
import {
  packIncremental, type IncrementalInput, type LayoutBaseline
} from "../../src/lib/core/incremental";
import { packFrames } from "../../src/lib/core/pack";

function frame(name: string, w: number, h: number, hash?: string): IncrementalInput {
  return { id: name, name, w, h, trim: { x: 0, y: 0, w, h }, srcW: w, srcH: h, duration: 100,
    hash: hash ?? `h:${name}:${w}x${h}` };
}
function baselineOf(inputs: IncrementalInput[], padding: number, maxSize: number): LayoutBaseline {
  const l = packFrames(inputs, padding, maxSize, false);
  return { atlasWidth: l.atlasWidth, atlasHeight: l.atlasHeight,
    frames: l.frames.map(f => { const s = inputs.find(x => x.id === f.id)!;
      return { name: f.name, w: f.w, h: f.h, trim: f.trim, srcW: f.srcW, srcH: f.srcH, hash: s.hash, x: f.x, y: f.y }; }) };
}

// 与 incremental.test.ts 相同的暴力参考（精简版）
interface BR { x: number; y: number; w: number; h: number }
function freeAfter(f: BR, r: BR): BR[] {
  const out: BR[] = [];
  if (!(r.x < f.x+f.w && f.x < r.x+r.w && r.y < f.y+f.h && f.y < r.y+r.h)) return [f];
  if (r.x > f.x) out.push({x:f.x,y:f.y,w:r.x-f.x,h:f.h});
  if (r.x+r.w < f.x+f.w) out.push({x:r.x+r.w,y:f.y,w:f.x+f.w-r.x-r.w,h:f.h});
  if (r.y > f.y) out.push({x:f.x,y:f.y,w:f.w,h:r.y-f.y});
  if (r.y+r.h < f.y+f.h) out.push({x:f.x,y:r.y+r.h,w:f.w,h:f.y+f.h-r.y-r.h});
  return out;
}
function occupies(free: BR[], r: BR): BR[] {
  let n: BR[] = [];
  for (const f of free) n = n.concat(freeAfter(f, r));
  return n.filter((a,i)=>!n.some((b,j)=>j!==i && b.x<=a.x&&b.y<=a.y&&b.x+b.w>=a.x+a.w&&b.y+b.h>=a.y+a.h&&(b.w*b.h>a.w*a.h||(b.w*b.h===a.w*a.h&&j<i))));
}
function canPack(free: BR[], rects: BR[]): boolean {
  if (!rects.length) return true;
  const sorted=[...rects].sort((a,b)=>b.w*b.h-a.w*a.h);
  const r0=sorted[0]!; const rest=sorted.slice(1);
  const cs=new Set<string>();
  for (const f of free) if (f.w>=r0.w&&f.h>=r0.h) {
    cs.add(`${f.x},${f.y}`); cs.add(`${f.x+f.w-r0.w},${f.y}`);
    cs.add(`${f.x},${f.y+f.h-r0.h}`); cs.add(`${f.x+f.w-r0.w},${f.y+f.h-r0.h}`);
  }
  for (const c of cs) { const [x,y]=c.split(",").map(Number)!;
    if (canPack(occupies(free,{x:x!,y:y!,w:r0.w,h:r0.h}),rest)) return true; }
  return false;
}
function brute(next: IncrementalInput[], bl: LayoutBaseline, pad: number, M: number): number|null {
  const old=new Map(bl.frames.map(f=>[f.name,f])); const pad2=pad*2;
  const kept=next.filter(f=>{const o=old.get(f.name);return o&&o.hash===f.hash;});
  let best:number|null=null;
  for (let mask=0;mask<1<<kept.length;mask++){
    const mc=kept.length-countBits(mask); if (best!==null&&mc>=best) continue;
    let free:BR[]=[{x:0,y:0,w:M,h:M}]; let ok=true;
    kept.forEach((f,i)=>{ if(!ok)return; if(mask&(1<<i)){const o=old.get(f.name)!;const b={x:o.x-pad,y:o.y-pad,w:f.w+pad2,h:f.h+pad2};
      if(!free.some(fr=>fr.x<=b.x&&fr.y<=b.y&&fr.x+fr.w>=b.x+b.w&&fr.y+fr.h>=b.y+b.h)){ok=false;return;} free=occupies(free,b);}});
    if(!ok)continue;
    const loose:BR[]=[];
    next.forEach((f)=>{const idx=kept.findIndex(x=>x.name===f.name); if(idx>=0&&(mask&(1<<idx)))return; loose.push({x:0,y:0,w:f.w+pad2,h:f.h+pad2});});
    if(canPack(free,loose))best=mc;
  }
  return best;
}
function countBits(n:number){let c=0;while(n){c+=n&1;n>>=1;}return c;}

describe("stress：400 随机场景与暴力最优一致", () => {
  it("heuristic == brute", () => {
    let seed = 987654321;
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed/0x100000000; };
    const names = ["a","b","c","d","e","f","g"];
    let checked = 0, feasible = 0;
    for (let t = 0; t < 400; t++) {
      const pad = Math.floor(rnd()*3);
      const M = [48,64,80,96,128][Math.floor(rnd()*5)]!;
      const n0 = 3+Math.floor(rnd()*4);
      const base = names.slice(0,n0).map(nm=>frame(nm,8+Math.floor(rnd()*40),8+Math.floor(rnd()*40)));
      let bl: LayoutBaseline;
      try { bl = baselineOf(base,pad,M); } catch { continue; }
      let next = base.map(f=>({...f}));
      if (rnd()<0.5 && next.length>2) next.splice(Math.floor(rnd()*next.length),1);
      if (rnd()<0.65 && next.length) { const i=Math.floor(rnd()*next.length); const f=next[i]!;
        next[i]=frame(f.name,8+Math.floor(rnd()*46),8+Math.floor(rnd()*46),`h:${f.name}:n${t}`); }
      if (rnd()<0.7) next.push(frame(`z${t}`,6+Math.floor(rnd()*34),6+Math.floor(rnd()*34)));
      const res = packIncremental(next,bl,{padding:pad,maxSize:M,pot:false,strategy:"stable"});
      const b = brute(next,bl,pad,M);
      if (b===null) { expect(res,`t${t}`).toBeNull(); }
      else { feasible++; expect(res,`t${t} has solution`).not.toBeNull();
        expect(res!.report.moved,`t${t} moves optimal`).toBe(b); }
      checked++;
    }
    console.log(`checked=${checked} feasible=${feasible}`);
    expect(checked).toBeGreaterThan(150);
    expect(feasible).toBeGreaterThan(80);
  }, 60000);
});
