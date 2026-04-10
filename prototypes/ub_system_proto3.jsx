import { useState, useRef, useEffect, useCallback } from "react";

/* ============================================================
   GEOMETRY
   ============================================================ */
function vec2(x,y){return{x:x,y:y}}
function vSub(a,b){return vec2(a.x-b.x,a.y-b.y)}
function vAdd(a,b){return vec2(a.x+b.x,a.y+b.y)}
function vSc(v,s){return vec2(v.x*s,v.y*s)}
function vLen(v){return Math.sqrt(v.x*v.x+v.y*v.y)}
function vNorm(v){var l=vLen(v);return l>1e-9?vec2(v.x/l,v.y/l):vec2(0,0)}
function vDot(a,b){return a.x*b.x+a.y*b.y}
function vPerp(v){return vec2(-v.y,v.x)}
function vCross(a,b){return a.x*b.y-a.y*b.x}

function ptIn(pt,poly){
  var ins=false;
  for(var i=0,j=poly.length-1;i<poly.length;j=i++){
    var yi=poly[i].y,yj=poly[j].y;
    if(((yi>pt.y)!==(yj>pt.y))&&(pt.x<(poly[j].x-poly[i].x)*(pt.y-yi)/(yj-yi)+poly[i].x))ins=!ins;
  }
  return ins;
}
function pCen(p){var cx=0,cy=0;for(var i=0;i<p.length;i++){cx+=p[i].x;cy+=p[i].y}return vec2(cx/p.length,cy/p.length)}
function pArea(p){var a=0;for(var i=0,j=p.length-1;i<p.length;j=i++)a+=(p[j].x+p[i].x)*(p[j].y-p[i].y);return a/2}
function makeCCW(p){return pArea(p)<0?p.slice().reverse():p}
function pBB(p){var x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(var i=0;i<p.length;i++){x0=Math.min(x0,p[i].x);y0=Math.min(y0,p[i].y);x1=Math.max(x1,p[i].x);y1=Math.max(y1,p[i].y)}return{minX:x0,minY:y0,maxX:x1,maxY:y1}}

function segT(p1,p2,p3,p4){
  var d1=vSub(p2,p1),d2=vSub(p4,p3),cr=vCross(d1,d2);
  if(Math.abs(cr)<1e-10)return null;
  var d3=vSub(p3,p1),t=vCross(d3,d2)/cr,u=vCross(d3,d1)/cr;
  if(t>=-1e-9&&t<=1+1e-9&&u>=-1e-9&&u<=1+1e-9)return Math.max(0,Math.min(1,t));
  return null;
}

function clipSeg(p1,p2,poly,inside){
  var ts=[];
  for(var i=0;i<poly.length;i++){var t=segT(p1,p2,poly[i],poly[(i+1)%poly.length]);if(t!==null)ts.push(t)}
  ts.sort(function(a,b){return a-b});
  var uTs=[0];for(var k=0;k<ts.length;k++){if(Math.abs(ts[k]-uTs[uTs.length-1])>1e-9)uTs.push(ts[k])}
  if(Math.abs(uTs[uTs.length-1]-1)>1e-9)uTs.push(1);
  var segs=[],dir=vSub(p2,p1);
  for(var i2=0;i2<uTs.length-1;i2++){
    var mid=(uTs[i2]+uTs[i2+1])/2;var isIn=ptIn(vAdd(p1,vSc(dir,mid)),poly);
    if(inside?isIn:!isIn)segs.push({start:vAdd(p1,vSc(dir,uTs[i2])),end:vAdd(p1,vSc(dir,uTs[i2+1]))});
  }
  return segs;
}

function subPolys(p1,p2,polys){
  var segs=[{start:p1,end:p2}];
  for(var pi=0;pi<polys.length;pi++){
    var nx=[];
    for(var si=0;si<segs.length;si++){
      var seg=segs[si];if(vLen(vSub(seg.end,seg.start))<0.1)continue;
      var cl=clipSeg(seg.start,seg.end,polys[pi],false);
      for(var ci=0;ci<cl.length;ci++){if(vLen(vSub(cl[ci].end,cl[ci].start))>0.1)nx.push(cl[ci])}
    }
    segs=nx;
  }
  return segs;
}

function longest(segs){
  if(!segs.length)return null;var b=segs[0];
  for(var i=1;i<segs.length;i++){if(vLen(vSub(segs[i].end,segs[i].start))>vLen(vSub(b.end,b.start)))b=segs[i]}
  return b;
}

function roundQuad(ctx,pts,r,mv){
  for(var i=0;i<4;i++){
    var pr=pts[(i+3)%4],cu=pts[i],nx=pts[(i+1)%4];
    var dP=vLen(vSub(pr,cu)),dN=vLen(vSub(nx,cu));
    var rr=Math.min(r,dP*0.4,dN*0.4);if(rr<0.5)rr=0;
    var pP=vAdd(cu,vSc(vNorm(vSub(pr,cu)),rr));
    if(i===0){if(mv)ctx.moveTo(pP.x,pP.y);else ctx.lineTo(pP.x,pP.y)}else ctx.lineTo(pP.x,pP.y);
    var pN=vAdd(cu,vSc(vNorm(vSub(nx,cu)),rr));
    if(rr>0)ctx.arcTo(cu.x,cu.y,pN.x,pN.y,rr);else ctx.lineTo(cu.x,cu.y);
  }
  ctx.closePath();
}

/* ============================================================
   POLYGON INWARD OFFSET
   ============================================================ */
function offsetPolygon(poly,dist){
  var n=poly.length;if(n<3)return{pts:[],vmap:[]};
  // Для каждой вершины: биссектриса внутренних нормалей смежных рёбер
  var pts=[],vmap=[];
  for(var i=0;i<n;i++){
    var prev=poly[(i-1+n)%n],cur=poly[i],next=poly[(i+1)%n];
    // Нормали двух рёбер (inward для CCW Y-up = правая нормаль)
    var d1=vSub(cur,prev),l1=vLen(d1);
    var d2=vSub(next,cur),l2=vLen(d2);
    if(l1<1e-9||l2<1e-9){pts.push(cur);vmap.push(i);continue}
    var n1=vec2(d1.y/l1,-d1.x/l1); // inward normal edge prev→cur
    var n2=vec2(d2.y/l2,-d2.x/l2); // inward normal edge cur→next
    // Биссектриса
    var bis=vAdd(n1,n2);var bisLen=vLen(bis);
    if(bisLen<1e-9){
      // Параллельные рёбра → просто сдвиг по нормали
      pts.push(vAdd(cur,vSc(n1,dist)));vmap.push(i);continue;
    }
    bis=vSc(bis,1/bisLen);
    // Масштаб: dist / sin(половина угла) = dist / dot(n1, bis)
    var sinHalf=vDot(n1,bis);
    if(Math.abs(sinHalf)<0.15)sinHalf=sinHalf>0?0.15:-0.15; // лимит для острых углов
    var offsetDist=dist/sinHalf;
    // Ограничиваем spike: не более 3x dist
    if(Math.abs(offsetDist)>dist*3)offsetDist=(offsetDist>0?1:-1)*dist*3;
    var off=vAdd(cur,vSc(bis,offsetDist));
    // Если выскочила за полигон — обрезаем до dist
    if(!ptIn(off,poly))off=vAdd(cur,vSc(bis,dist));
    pts.push(off);vmap.push(i);
  }
  return{pts:pts,vmap:vmap};
}

/* ============================================================
   CAMERA (plain object, no class)
   ============================================================ */
function makeCam(cx,cy,z){return{cx:cx,cy:cy,z:z}}
function w2s(cam,wx,wy,W,H){return{x:(wx-cam.cx)*cam.z+W/2,y:-(wy-cam.cy)*cam.z+H/2}}
function s2w(cam,sx,sy,W,H){return{x:(sx-W/2)/cam.z+cam.cx,y:-(sy-H/2)/cam.z+cam.cy}}
function fitCam(p,W,H){var b=pBB(p);var z=Math.min(W/((b.maxX-b.minX)*1.3),H/((b.maxY-b.minY)*1.3));return makeCam((b.minX+b.maxX)/2,(b.minY+b.maxY)/2,z)}

/* ============================================================
   CORE
   ============================================================ */
function extractEdges(p){var e=[];for(var i=0;i<p.length;i++){var s=p[i],en=p[(i+1)%p.length],l=vLen(vSub(en,s));if(l>0.5)e.push({id:i,start:s,end:en,length:l})}return e}
function classOri(edges){for(var i=0;i<edges.length;i++){var e=edges[i];var d=vNorm(vSub(e.end,e.start));e.dotP=Math.abs(vDot(vec2(0,1),d));e.orientation=e.dotP>=0.7?1:0}return edges}
function assignCtx(edges){var s=edges.slice().sort(function(a,b){return b.length-a.length});for(var i=0;i<s.length;i++)s[i].context=i<1?0:i<2?1:2;return edges}
function sortPrio(edges){return edges.slice().sort(function(a,b){if(a.context!==b.context)return a.context-b.context;if(a.orientation!==b.orientation)return b.orientation-a.orientation;return b.length-a.length})}
function calcOff(edge,poly,sw){var d=vNorm(vSub(edge.end,edge.start)),pp=vPerp(d),mid=vSc(vAdd(edge.start,edge.end),0.5),cen=pCen(poly);var t1=vAdd(mid,vSc(pp,sw)),t2=vAdd(mid,vSc(pp,-sw));var od;if(ptIn(t1,poly))od=pp;else if(ptIn(t2,poly))od=vSc(pp,-1);else od=vLen(vSub(t1,cen))<vLen(vSub(t2,cen))?pp:vSc(pp,-1);return{od:od,oS:vAdd(edge.start,vSc(od,sw)),oE:vAdd(edge.end,vSc(od,sw))}}

/* ============================================================
   BUFFERS
   ============================================================ */
function makeBufs(edge,oi,par){
  var S=edge.start,E=edge.end,od=oi.od,oS=oi.oS,oE=oi.oE;
  var d=vNorm(vSub(E,S)),nod=vSc(od,-1);
  var fire=[vAdd(S,vSc(nod,par.fire)),vAdd(E,vSc(nod,par.fire)),vAdd(oE,vSc(od,par.fire)),vAdd(oS,vSc(od,par.fire))];
  var end=[vAdd(vAdd(S,vSc(d,-par.endB)),vSc(nod,par.endB)),vAdd(vAdd(E,vSc(d,par.endB)),vSc(nod,par.endB)),vAdd(vAdd(oE,vSc(d,par.endB)),vSc(od,par.endB)),vAdd(vAdd(oS,vSc(d,-par.endB)),vSc(od,par.endB))];
  var insol=[vAdd(S,vSc(nod,par.insol)),vAdd(E,vSc(nod,par.insol)),vAdd(oE,vSc(od,par.insol)),vAdd(oS,vSc(od,par.insol))];
  return{fire:fire,end:end,insol:insol,base:[S,E,oE,oS]};
}

/* ============================================================
   PRIORITY TRIMMING
   ============================================================ */
function prioTrim(sorted,poly,par){
  var res=[],allBufs=[];
  for(var i=0;i<sorted.length;i++){
    var e=Object.assign({},sorted[i]);var oi=calcOff(e,poly,par.sw);
    if(i===0){var b=makeBufs(e,oi,par);allBufs.push(b.fire,b.end,b.insol);res.push(Object.assign({},e,{oi:oi,bufs:b,trimmed:false}));continue}
    var segs=subPolys(oi.oS,oi.oE,allBufs);var best=longest(segs);
    if(!best||vLen(vSub(best.end,best.start))<3){res.push(Object.assign({},e,{length:0,oi:oi,bufs:null,trimmed:true,secs:[]}));continue}
    var bk=vSc(oi.od,-par.sw);var nS=vAdd(best.start,bk),nE=vAdd(best.end,bk);
    var te=Object.assign({},e,{start:nS,end:nE,length:vLen(vSub(nE,nS)),trimmed:true,origStart:e.start,origEnd:e.end,origLen:e.length});
    var nOi=calcOff(te,poly,par.sw);var b2=makeBufs(te,nOi,par);
    allBufs.push(b2.fire,b2.end,b2.insol);res.push(Object.assign({},te,{oi:nOi,bufs:b2}));
  }
  return res;
}

function boundTrim(edges,poly,par){
  for(var i=0;i<edges.length;i++){var e=edges[i];
    if(e.length<1||!e.oi)continue;
    var segs=clipSeg(e.oi.oS,e.oi.oE,poly,true);var best=longest(segs);
    if(!best){e.length=0;e.secs=[];continue}
    var nl=vLen(vSub(best.end,best.start)),ol=vLen(vSub(e.oi.oE,e.oi.oS));
    if(Math.abs(nl-ol)<0.5)continue;
    var bk=vSc(e.oi.od,-par.sw);
    if(!e.origStart){e.origStart=e.start;e.origEnd=e.end;e.origLen=e.length}
    e.start=vAdd(best.start,bk);e.end=vAdd(best.end,bk);e.length=vLen(vSub(e.end,e.start));e.trimmed=true;
    e.oi=calcOff(e,poly,par.sw);if(e.bufs)e.bufs=makeBufs(e,e.oi,par);
  }
  return edges;
}

/* ============================================================
   SECTION DISTRIBUTION (strict)
   ============================================================ */
function distribute(lens,axLen){
  var sorted=lens.slice().sort(function(a,b){return b-a});
  var bc=sorted.map(function(){return 0}),br=axLen;
  function tf(r,c,idx){
    if(idx>=sorted.length){if(r>=0&&r<br){bc=c.slice();br=r}return}
    for(var k=Math.floor(r/sorted[idx]);k>=0;k--){c[idx]=k;var nr=r-sorted[idx]*k;if(nr>=0)tf(nr,c,idx+1)}
  }
  tf(axLen,sorted.map(function(){return 0}),0);
  return{counts:bc,rem:br,sorted:sorted};
}

function makeSectionSeq(allowedLens,axLen,tg){
  var r=distribute(allowedLens,axLen);var counts=r.counts,sorted=r.sorted;
  var res=[];
  for(var i=0;i<counts.length;i++)for(var j=0;j<counts[i];j++)res.push({l:sorted[i],gap:false});
  if(axLen>=150&&res.length>=4){
    var removed=0,mi=Math.floor(res.length/2);
    while(removed<tg&&res.length>2){var rm=res.splice(mi,1)[0];removed+=rm.l}
    if(removed>=20){res.splice(Math.min(mi,res.length),0,{l:removed,gap:true})}
    else{res=[];for(var i2=0;i2<counts.length;i2++)for(var j2=0;j2<counts[i2];j2++)res.push({l:sorted[i2],gap:false})}
  }
  return res.filter(function(s){return s.gap||allowedLens.some(function(l){return Math.abs(l-s.l)<0.01})});
}

function placeSecs(edge,seq,sw){
  var secs=[],tl=edge.length,od=edge.oi.od;var pos=0;
  for(var i=0;i<seq.length;i++){var s=seq[i];
    var t0=pos/tl,t1=Math.min((pos+s.l)/tl,1);
    var sP=vAdd(edge.start,vSc(vSub(edge.end,edge.start),t0));
    var eP=vAdd(edge.start,vSc(vSub(edge.end,edge.start),t1));
    secs.push({length:s.l,isGap:s.gap,rect:[sP,eP,vAdd(eP,vSc(od,sw)),vAdd(sP,vSc(od,sw))]});
    pos+=s.l;
  }
  return secs;
}

/* ============================================================
   TOWER DISTRIBUTION — башни с обязательным 20м разрывом
   ============================================================ */
var TOWER_W=23.1; // ширина башни (перпендикуляр к оси)
var TOWER_LAT=[23.1]; // на широтной оси — только квадрат
var TOWER_LON=[23.1,29.7,39.6]; // на меридиональной — максимизируем
var TOWER_GAP=20; // обязательный разрыв

function makeTowerSeq(allowedLens,axLen){
  var sorted=allowedLens.slice().sort(function(a,b){return b-a});
  var minL=sorted[sorted.length-1];
  var bestSeq=null,bestUsed=0;

  // Перебираем количество башен 1..max
  var maxT=Math.floor((axLen+TOWER_GAP)/(minL+TOWER_GAP));
  if(maxT<1&&minL<=axLen)maxT=1;

  for(var nt=1;nt<=Math.min(maxT,8);nt++){
    var avail=axLen-(nt-1)*TOWER_GAP;
    if(avail<minL*nt)continue;

    // Для nt башен: перебираем комбинации рекурсивно
    var bestCombo=null,bestComboUsed=0;
    function tryCombo(remaining,count,combo){
      if(count===nt){
        var used=0;for(var i=0;i<combo.length;i++)used+=combo[i];
        if(remaining>=0&&used>bestComboUsed){bestComboUsed=used;bestCombo=combo.slice()}
        return;
      }
      for(var si=0;si<sorted.length;si++){
        if(sorted[si]<=remaining){
          combo.push(sorted[si]);
          tryCombo(remaining-sorted[si],count+1,combo);
          combo.pop();
        }
      }
    }
    tryCombo(avail,0,[]);

    if(bestCombo&&bestComboUsed>bestUsed){
      bestUsed=bestComboUsed;bestSeq=bestCombo;
    }
  }

  if(!bestSeq){
    if(minL<=axLen)bestSeq=[minL];
    else return[];
  }

  // Строим последовательность с разрывами
  var result=[];
  for(var k=0;k<bestSeq.length;k++){
    result.push({l:bestSeq[k],gap:false,tower:true});
    if(k<bestSeq.length-1)result.push({l:TOWER_GAP,gap:true,tower:false});
  }
  return result;
}

function placeTowers(edge,seq,tw){
  // tw = tower width (23.1м)
  var secs=[],tl=edge.length,od=edge.oi.od;var pos=0;
  for(var i=0;i<seq.length;i++){var s=seq[i];
    var t0=pos/tl,t1=Math.min((pos+s.l)/tl,1);
    var sP=vAdd(edge.start,vSc(vSub(edge.end,edge.start),t0));
    var eP=vAdd(edge.start,vSc(vSub(edge.end,edge.start),t1));
    secs.push({length:s.l,isGap:s.gap,isTower:s.tower||false,rect:[sP,eP,vAdd(eP,vSc(od,tw)),vAdd(sP,vSc(od,tw))]});
    pos+=s.l;
  }
  return secs;
}

/* ============================================================
   OBB — Minimum Oriented Bounding Box
   ============================================================ */
function computeOBB(poly){
  // Перебираем углы рёбер полигона, ищем минимальную площадь AABB после поворота
  var bestAngle=0,bestArea=Infinity,bestW=0,bestH=0,bestCx=0,bestCy=0;
  for(var i=0;i<poly.length;i++){
    var a=poly[i],b=poly[(i+1)%poly.length];
    var dx=b.x-a.x,dy=b.y-a.y;
    var angle=Math.atan2(dy,dx);
    var cosA=Math.cos(-angle),sinA=Math.sin(-angle);
    var mnX=Infinity,mnY=Infinity,mxX=-Infinity,mxY=-Infinity;
    for(var j=0;j<poly.length;j++){
      var rx=poly[j].x*cosA-poly[j].y*sinA;
      var ry=poly[j].x*sinA+poly[j].y*cosA;
      if(rx<mnX)mnX=rx;if(ry<mnY)mnY=ry;if(rx>mxX)mxX=rx;if(ry>mxY)mxY=ry;
    }
    var w=mxX-mnX,h=mxY-mnY,area=w*h;
    if(area<bestArea){bestArea=area;bestAngle=angle;bestW=w;bestH=h;
      var rcx=(mnX+mxX)/2,rcy=(mnY+mxY)/2;
      var cosB=Math.cos(angle),sinB=Math.sin(angle);
      bestCx=rcx*cosB-rcy*sinB;bestCy=rcx*sinB+rcy*cosB;
    }
  }
  // d1 = вдоль длинной стороны, d2 = вдоль короткой
  var cosA2=Math.cos(bestAngle),sinA2=Math.sin(bestAngle);
  var d1=vec2(cosA2,sinA2),d2=vec2(-sinA2,cosA2);
  if(bestW<bestH){var tmp=d1;d1=d2;d2=tmp;var tw=bestW;bestW=bestH;bestH=tw}
  return{angle:bestAngle,cx:bestCx,cy:bestCy,w:bestW,h:bestH,d1:d1,d2:d2};
}

function genGrid(poly,step,obb){
  var h=[],v=[];
  var d1=obb.d1,d2=obb.d2;
  var center=vec2(obb.cx,obb.cy);
  var halfW=obb.w/2+step,halfH=obb.h/2+step;
  // Линии вдоль d1 (сдвигаются по d2)
  for(var t=-halfH;t<=halfH;t+=step){
    var origin=vAdd(center,vSc(d2,t));
    var p1=vAdd(origin,vSc(d1,-halfW));
    var p2=vAdd(origin,vSc(d1,halfW));
    var sg=clipSeg(p1,p2,poly,true);
    for(var i=0;i<sg.length;i++)h.push(sg[i]);
  }
  // Линии вдоль d2 (сдвигаются по d1)
  for(var t2=-halfW;t2<=halfW;t2+=step){
    var origin2=vAdd(center,vSc(d1,t2));
    var p3=vAdd(origin2,vSc(d2,-halfH));
    var p4=vAdd(origin2,vSc(d2,halfH));
    var sg2=clipSeg(p3,p4,poly,true);
    for(var j=0;j<sg2.length;j++)v.push(sg2[j]);
  }
  return{h:h,v:v};
}

/* ============================================================ */
var PR={
  "Прямоугольник":[vec2(0,0),vec2(180,0),vec2(180,120),vec2(0,120)],
  "L-образный":[vec2(0,0),vec2(140,0),vec2(140,60),vec2(200,60),vec2(200,160),vec2(0,160)],
  "Трапеция":[vec2(30,0),vec2(170,0),vec2(200,140),vec2(0,140)],
  "Пятиугольник":[vec2(100,0),vec2(200,55),vec2(170,160),vec2(30,160),vec2(0,55)],
  "Сложный":[vec2(10,0),vec2(110,-10),vec2(190,20),vec2(210,95),vec2(170,175),vec2(90,190),vec2(0,150),vec2(-5,60)],
};
var CC={0:{m:"#e63946",f:"rgba(230,57,70,0.5)",l:"Магистраль"},1:{m:"#f4a261",f:"rgba(244,162,97,0.5)",l:"Граница"},2:{m:"#457b9d",f:"rgba(69,123,157,0.5)",l:"Внутренняя"}};

/* ============================================================
   OPTIMIZER: перебор контекстов для максимума секций
   ============================================================ */
function scorePipeline(baseEdges,ctxArr,p,par,ll,lo,sw2,tg2){
  var edges=[];
  for(var i=0;i<baseEdges.length;i++)edges.push(Object.assign({},baseEdges[i],{context:ctxArr[i]}));
  var sorted=sortPrio(edges);
  var trimmed=prioTrim(sorted,p,par);
  trimmed=boundTrim(trimmed,p,par);
  var totalSecs=0,totalLen=0;
  for(var ti=0;ti<trimmed.length;ti++){
    var e=trimmed[ti];if(e.length<3||!e.oi)continue;
    var lens=e.orientation===0?ll:lo;
    var minL=Math.min.apply(null,lens);if(e.length<minL)continue;
    var r=distribute(lens,e.length);
    for(var j=0;j<r.counts.length;j++){totalSecs+=r.counts[j];totalLen+=r.sorted[j]*r.counts[j]}
  }
  return{secs:totalSecs,len:totalLen};
}

function autoOptimize(baseEdges,p,par,ll,lo,sw2,tg2){
  var n=baseEdges.length;
  var bestScore=-1,bestLen=0,bestCtx=null;
  // 3^n для n≤6 (729), иначе 2000 случайных
  var total=Math.pow(3,n);
  var exhaustive=n<=6;
  var iters=exhaustive?total:2000;
  for(var it=0;it<iters;it++){
    var ctxArr=[];
    if(exhaustive){
      var tmp=it;for(var i=0;i<n;i++){ctxArr.push(tmp%3);tmp=Math.floor(tmp/3)}
    }else{
      for(var i2=0;i2<n;i2++)ctxArr.push(Math.floor(Math.random()*3));
    }
    var sc=scorePipeline(baseEdges,ctxArr,p,par,ll,lo,sw2,tg2);
    if(sc.secs>bestScore||(sc.secs===bestScore&&sc.len>bestLen)){
      bestScore=sc.secs;bestLen=sc.len;bestCtx=ctxArr.slice();
    }
  }
  return bestCtx;
}

/* ============================================================
   APP
   ============================================================ */
export default function App(){
  var cvRef=useRef(null);
  var [mode,setMode]=useState("draw");
  var [dPts,setDPts]=useState([]);
  var [poly,setPoly]=useState(null);
  var [mw,setMw]=useState(null);
  var camRef=useRef(makeCam(100,80,3.5));
  var [ct,setCt]=useState(0);
  var panRef=useRef(null);
  var CW=800,CH=550;

  var [gridStep,setGridStep]=useState(6);
  var [sw,setSw]=useState(15);
  var [fb,setFb]=useState(14);
  var [eb,setEb]=useState(20);
  var [ib,setIb]=useState(30);
  var [latL,setLatL]=useState("27,30");
  var [lonL,setLonL]=useState("36,39,42,46,49");
  var [tg,setTg]=useState(22);
  var [ctxRoll,setCtxRoll]=useState(0);
  var [typo,setTypo]=useState(0);
  var [ctxOverride,setCtxOverride]=useState(null); // null = auto/roll, array = optimized

  var [vGrid,setVGrid]=useState(true);
  var [vBuf,setVBuf]=useState(true);
  var [vSec,setVSec]=useState(true);
  var [vAx,setVAx]=useState(true);
  var [vLab,setVLab]=useState(true);
  var [vGhost,setVGhost]=useState(true);
  var [vYard,setVYard]=useState(true);
  var [vRoad,setVRoad]=useState(true);
  var [vGraph,setVGraph]=useState(true);
  var [vTrash,setVTrash]=useState(false);
  var [vPlay,setVPlay]=useState(false);
  var [comp,setComp]=useState(null);
  var [err,setErr]=useState(null);

  var pL=function(s){return s.split(",").map(function(v){return parseFloat(v.trim())}).filter(function(v){return !isNaN(v)&&v>0})};

  /* PIPELINE */
  useEffect(function(){
    try{
    if(!poly||poly.length<3){setComp(null);return}
    var p=makeCCW(poly);
    var ll=pL(latL),lo=pL(lonL);
    if(!ll.length||!lo.length){setComp(null);return}
    var par={sw:sw,fire:fb,endB:eb,insol:ib};
    var obb=computeOBB(p);
    var grid=genGrid(p,gridStep,obb);

    var edges=extractEdges(p);edges=classOri(edges);
    if(ctxOverride&&ctxOverride.length===edges.length){
      for(var ei=0;ei<edges.length;ei++)edges[ei].context=ctxOverride[ei];
    }else if(ctxRoll===0){edges=assignCtx(edges)}
    else{var seed=ctxRoll*7919;var rng=function(){seed=(seed*16807)%2147483647;return seed/2147483647};for(var ei=0;ei<edges.length;ei++)edges[ei].context=Math.floor(rng()*3)}
    var sorted=sortPrio(edges);

    var trimmed=prioTrim(sorted,p,par);
    trimmed=boundTrim(trimmed,p,par);

    var pick=function(e){return e.orientation===0?{lens:ll,tag:"ш"}:{lens:lo,tag:"м"}};

    // Для tower+sections: находим самый северный угол и ось для башни
    var towerEdgeId=-1;
    if(typo===1){
      // Самая северная вершина полигона (max Y)
      var northIdx=0;
      for(var ni=1;ni<p.length;ni++){if(p[ni].y>p[northIdx].y)northIdx=ni}
      // Рёбра, примыкающие к этой вершине
      var prevEdgeIdx=(northIdx-1+p.length)%p.length;
      var nextEdgeIdx=northIdx;
      // Ищем эти рёбра среди trimmed (по id)
      var candidates=[];
      for(var ci2=0;ci2<trimmed.length;ci2++){
        var te2=trimmed[ci2];
        if(te2.removed||te2.length<23.1||!te2.oi)continue;
        if(te2.id===prevEdgeIdx||te2.id===nextEdgeIdx)candidates.push(te2);
      }
      // Предпочитаем меридиональную, иначе широтную
      candidates.sort(function(a,b){return b.orientation-a.orientation||b.length-a.length});
      if(candidates.length>0)towerEdgeId=candidates[0].id;
    }

    for(var ti=0;ti<trimmed.length;ti++){var te=trimmed[ti];
      if(te.length<1||!te.oi)continue;
      // Для башенной оси: минимум = 23.1, для обычных — по pick
      var minCheck;
      if(typo===1&&te.id===towerEdgeId){minCheck=23.1}
      else{var pl=pick(te);minCheck=Math.min.apply(null,pl.lens)}
      if(te.length<minCheck){te.length=0;te.bufs=null;te.secs=[];te.removed=true}
    }

    var withSecs=trimmed.map(function(e){
      if(e.length<3||!e.oi||e.removed)return Object.assign({},e,{secs:[],secTag:""});

      // Tower mode: башня на выбранной оси
      if(typo===1&&e.id===towerEdgeId){
        var tLens=e.orientation===1?TOWER_LON:TOWER_LAT;
        e.secTag="Б";e.allowedLens=tLens.slice();e.isTowerEdge=true;
        var tSeq=makeTowerSeq(tLens,e.length);
        var tSecs=placeTowers(e,tSeq,TOWER_W);
        for(var si2=0;si2<tSecs.length;si2++){var ts=tSecs[si2];if(!ts.isGap&&!ts.isTower)continue;
          if(ts.isTower){var ok2=tLens.some(function(l){return Math.abs(l-ts.length)<0.01});if(!ok2)ts.BAD=true}}
        return Object.assign({},e,{secs:tSecs});
      }

      // Обычные секции
      var pl=pick(e);e.secTag=pl.tag;e.allowedLens=pl.lens.slice();
      var seq=makeSectionSeq(pl.lens,e.length,tg);
      var secs=placeSecs(e,seq,sw);
      for(var si=0;si<secs.length;si++){var sec=secs[si];if(!sec.isGap){var ok=pl.lens.some(function(l){return Math.abs(l-sec.length)<0.01});if(!ok)sec.BAD=true}}
      return Object.assign({},e,{secs:secs});
    });

    var secFire=[];
    var roadBuf=[];
    var trashInner=[],trashOuter=[];
    var playBuf12=[],playBuf20=[],playBuf40=[];
    var RB=14;
    var TB_IN=20,TB_OUT=100;
    for(var wi=0;wi<withSecs.length;wi++){var we=withSecs[wi];
      if(!we.secs||!we.secs.length||!we.oi)continue;
      var groups=[],cur=null;
      for(var si2=0;si2<we.secs.length;si2++){var sec2=we.secs[si2];if(sec2.isGap){cur=null;continue}if(!cur){cur=[sec2];groups.push(cur)}else cur.push(sec2)}
      for(var gi=0;gi<groups.length;gi++){var g=groups[gi];
        var f=g[0].rect,la=g[g.length-1].rect;
        var od=vNorm(vSub(f[3],f[0])),nod=vSc(od,-1);
        secFire.push([vAdd(f[0],vSc(nod,fb)),vAdd(la[1],vSc(nod,fb)),vAdd(la[2],vSc(od,fb)),vAdd(f[3],vSc(od,fb))]);
        var axDir=vNorm(vSub(la[1],f[0]));
        var negAx=vSc(axDir,-1);
        // Функция для буфера D метров во все стороны
        function mkBuf(D){return[
          vAdd(vAdd(f[0],vSc(nod,D)),vSc(negAx,D)),
          vAdd(vAdd(la[1],vSc(nod,D)),vSc(axDir,D)),
          vAdd(vAdd(la[2],vSc(od,D)),vSc(axDir,D)),
          vAdd(vAdd(f[3],vSc(od,D)),vSc(negAx,D))
        ]}
        roadBuf.push(mkBuf(RB));
        trashInner.push(mkBuf(TB_IN));
        trashOuter.push(mkBuf(TB_OUT));
        playBuf12.push(mkBuf(12));
        playBuf20.push(mkBuf(20));
        playBuf40.push(mkBuf(40));
      }
    }
    // ШАГ 14: Пожарный проезд
    var roadCenter=sw+fb-3;
    var roadOuterRes=offsetPolygon(p,roadCenter-3);
    var roadInnerRes=offsetPolygon(p,roadCenter+3);

    // ШАГ 15: Коннекторы — пересечение рёбер ДОРОЖНОГО буфера с полигоном и дорогой
    var connectors=[];
    var roadOuterPoly=roadOuterRes.pts;

    // ШАГ 15: Коннекторы через рёбра roadBuf (14м буфер)
    // Каждое ребро roadBuf × полигон → polyHits, × roadInner → innerHits → пары

    // Пересечение двух отрезков → точка или null
    function segSeg(p1,p2,p3,p4){
      var d1=vSub(p2,p1),d2=vSub(p4,p3),cr=vCross(d1,d2);
      if(Math.abs(cr)<1e-10)return null;
      var d3=vSub(p3,p1);
      var t=vCross(d3,d2)/cr,u=vCross(d3,d1)/cr;
      if(t>=0&&t<=1&&u>=0&&u<=1)return vAdd(p1,vSc(d1,t));
      return null;
    }
    // ВСЕ пересечения отрезка с полигоном
    function allHits(sa,sb,poly){
      var pts=[];
      for(var i=0;i<poly.length;i++){
        var pt=segSeg(sa,sb,poly[i],poly[(i+1)%poly.length]);
        if(pt)pts.push(pt);
      }
      return pts;
    }

    var roadInnerPoly=roadInnerRes.pts;

    // ВСЕ 4 ребра каждого roadBuf, каждое удлинено ±50м
    for(var fri=0;fri<roadBuf.length;fri++){
      var fr=roadBuf[fri];
      var bufCen=vSc(vAdd(vAdd(fr[0],fr[1]),vAdd(fr[2],fr[3])),0.25);
      for(var fei=0;fei<4;fei++){
        var ea=fr[fei],eb3=fr[(fei+1)%4];
        var eDir=vNorm(vSub(eb3,ea));
        // Удлиняем ±50м
        var extA=vAdd(ea,vSc(eDir,-50));
        var extB=vAdd(eb3,vSc(eDir,50));
        var ph=allHits(extA,extB,p);
        var ih=(roadInnerPoly.length>=3)?allHits(extA,extB,roadInnerPoly):[];
        // Для каждого polyHit → ближайший innerHit
        for(var phi2=0;phi2<ph.length;phi2++){
          var ppt=ph[phi2];
          var bestI=null,bestD=Infinity;
          for(var ihi2=0;ihi2<ih.length;ihi2++){
            var dd=vLen(vSub(ih[ihi2],ppt));
            if(dd>0.5&&dd<bestD){bestD=dd;bestI=ih[ihi2]}
          }
          if(bestI&&bestD<80){
            var ext5=vNorm(vSub(bestI,ppt));
            connectors.push({from:ppt,to:vAdd(bestI,vSc(ext5,5)),type:"buf",bufCen:bufCen});
          }
        }
      }
    }

    // GAP-коннекторы: перпендикуляр из зазора наружу, длинный отрезок
    for(var gwi=0;gwi<withSecs.length;gwi++){
      var gwe=withSecs[gwi];
      if(!gwe.secs||!gwe.oi||gwe.removed)continue;
      for(var gsi=0;gsi<gwe.secs.length;gsi++){
        var gs=gwe.secs[gsi];if(!gs.isGap)continue;
        var gMid=vSc(vAdd(vSc(vAdd(gs.rect[0],gs.rect[1]),0.5),vSc(vAdd(gs.rect[2],gs.rect[3]),0.5)),0.5);
        var gOd=vNorm(vSub(gs.rect[3],gs.rect[0]));
        var gNod=vSc(gOd,-1);
        var gFar=vAdd(gMid,vSc(gNod,200));
        var gPH=allHits(gMid,gFar,p);
        var gIH=(roadInnerPoly.length>=3)?allHits(gMid,gFar,roadInnerPoly):[];
        if(gPH.length>0&&gIH.length>0){
          // Ближайший poly + ближайший inner
          var gBP=gPH[0],gBI=gIH[0];
          for(var gi4=1;gi4<gPH.length;gi4++)if(vLen(vSub(gPH[gi4],gMid))<vLen(vSub(gBP,gMid)))gBP=gPH[gi4];
          for(var gi5=1;gi5<gIH.length;gi5++)if(vLen(vSub(gIH[gi5],gMid))<vLen(vSub(gBI,gMid)))gBI=gIH[gi5];
          var gExt=vNorm(vSub(gBI,gBP));
          connectors.push({from:gBP,to:vAdd(gBI,vSc(gExt,5)),type:"gap",bufCen:vAdd(gMid,vSc(gNod,20))});
        }
      }
    }

    // ШАГ 15.5: Фильтр коллизий — удаляем коннекторы, пересекающие секции
    var allSecRects=[];
    for(var fsi=0;fsi<withSecs.length;fsi++){
      var fse=withSecs[fsi];
      if(!fse.secs)continue;
      for(var fsj=0;fsj<fse.secs.length;fsj++){
        var fs=fse.secs[fsj];
        if(!fs.isGap)allSecRects.push(fs.rect);
      }
    }
    function segHitsQuad(sa,sb,quad){
      for(var qi=0;qi<4;qi++){
        if(segSeg(sa,sb,quad[qi],quad[(qi+1)%4]))return true;
      }
      return false;
    }
    var filtered=[];
    for(var fci=0;fci<connectors.length;fci++){
      var fc=connectors[fci];
      var collides=false;
      for(var rci=0;rci<allSecRects.length;rci++){
        if(segHitsQuad(fc.from,fc.to,allSecRects[rci])){collides=true;break}
      }
      if(!collides)filtered.push(fc);
    }
    connectors=filtered;

    // ШАГ 16: Связный граф — вставляем точки стыковки в кольцо roadInner
    var graphNodes=[];var graphEdges=[];

    // Строим кольцо из roadInner с вставкой точек коннекторов
    // Для каждого ребра roadInner собираем коннекторы, которые его пересекают
    var ringPts=roadInnerPoly.slice(); // копия
    // Для каждого коннектора: найти точное пересечение линии (from→to) с roadInner
    var connInserts=[]; // {edgeIdx, t, pt, connIdx}
    for(var gci=0;gci<connectors.length;gci++){
      var cn=connectors[gci];
      var dir3=vNorm(vSub(cn.to,cn.from));
      // Луч от from в сторону to, ищем пересечение с roadInner рёбрами
      var bestT3=Infinity,bestPt3=null,bestEdge3=-1;
      for(var rei=0;rei<ringPts.length;rei++){
        var ra=ringPts[rei],rb=ringPts[(rei+1)%ringPts.length];
        var d2=vSub(rb,ra),d3=vSub(ra,cn.from);
        var cr=vCross(dir3,d2);if(Math.abs(cr)<1e-10)continue;
        var t=vCross(d3,d2)/cr,u=vCross(d3,dir3)/cr;
        if(t>0.1&&u>=0&&u<=1&&t<bestT3){bestT3=t;bestPt3=vAdd(cn.from,vSc(dir3,t));bestEdge3=rei}
      }
      if(bestPt3&&bestEdge3>=0){
        // t вдоль ребра для сортировки при вставке
        var eA=ringPts[bestEdge3],eB=ringPts[(bestEdge3+1)%ringPts.length];
        var eDir=vSub(eB,eA);var eLen2=vLen(eDir);
        var tOnEdge=eLen2>0.01?vDot(vSub(bestPt3,eA),eDir)/(eLen2*eLen2):0;
        connInserts.push({edgeIdx:bestEdge3,tOnEdge:tOnEdge,pt:bestPt3,connIdx:gci});
      }
    }

    // Группируем вставки по ребру, сортируем по t
    var insertsByEdge={};
    for(var ii4=0;ii4<connInserts.length;ii4++){
      var ci4=connInserts[ii4];
      if(!insertsByEdge[ci4.edgeIdx])insertsByEdge[ci4.edgeIdx]=[];
      insertsByEdge[ci4.edgeIdx].push(ci4);
    }
    for(var key in insertsByEdge)insertsByEdge[key].sort(function(a,b){return a.tOnEdge-b.tOnEdge});

    // Строим расширенное кольцо: оригинальные вершины + вставленные точки
    var expandedRing=[]; // {pt, type:"ring"|"junction", connIdx or -1}
    for(var eri=0;eri<ringPts.length;eri++){
      expandedRing.push({pt:ringPts[eri],type:"ring",connIdx:-1});
      // Вставляем точки коннекторов на этом ребре
      var ins=insertsByEdge[eri];
      if(ins){
        for(var ini=0;ini<ins.length;ini++){
          expandedRing.push({pt:ins[ini].pt,type:"junction",connIdx:ins[ini].connIdx});
        }
      }
    }

    // Создаём узлы графа: кольцо
    for(var eni=0;eni<expandedRing.length;eni++){
      graphNodes.push({pt:expandedRing[eni].pt,type:expandedRing[eni].type});
    }
    // Рёбра кольца (замкнутый цикл по expanded ring)
    for(var eei=0;eei<expandedRing.length;eei++){
      graphEdges.push({a:eei,b:(eei+1)%expandedRing.length,type:"ring"});
    }

    // Рёбра коннекторов: от boundary-узла до junction-узла на кольце
    for(var gci2=0;gci2<connectors.length;gci2++){
      var cn2=connectors[gci2];
      // Находим junction-узел для этого коннектора
      var jIdx=-1;
      for(var ji=0;ji<expandedRing.length;ji++){
        if(expandedRing[ji].connIdx===gci2){jIdx=ji;break}
      }
      if(jIdx<0)continue;
      // Узел на границе полигона
      var bIdx2=graphNodes.length;
      graphNodes.push({pt:cn2.from,type:"boundary"});
      // Ребро: граница → junction на кольце
      graphEdges.push({a:bIdx2,b:jIdx,type:"conn"});
    }

    // ШАГ 17: Контейнерная площадка 6×3м
    // Ищем на сетке OBB позицию: внутри полигона, внутри trashZone (20-100м), вне дорог/секций, макс удаление от центра
    var trashPad=null,trashPadBuf=null;
    if(trashOuter.length>0){
      var padW=6,padH=3;
      var cen2=pCen(p);
      var bestDist=-1;
      var d1=obb.d1,d2=obb.d2;
      var hW2=obb.w/2+10,hH2=obb.h/2+10;
      var roP=roadOuterRes.pts;

      for(var gx=-hW2;gx<=hW2;gx+=gridStep){
        for(var gy=-hH2;gy<=hH2;gy+=gridStep){
          var cx2=obb.cx+d1.x*gx+d2.x*gy;
          var cy2=obb.cy+d1.y*gx+d2.y*gy;
          var center=vec2(cx2,cy2);

          // Rect 6×3 по осям OBB
          var corners=[
            vAdd(center,vAdd(vSc(d1,-padW/2),vSc(d2,-padH/2))),
            vAdd(center,vAdd(vSc(d1,padW/2),vSc(d2,-padH/2))),
            vAdd(center,vAdd(vSc(d1,padW/2),vSc(d2,padH/2))),
            vAdd(center,vAdd(vSc(d1,-padW/2),vSc(d2,padH/2)))
          ];

          // Все углы внутри полигона
          var allIn=true;
          for(var ci3=0;ci3<4;ci3++){if(!ptIn(corners[ci3],p)){allIn=false;break}}
          if(!allIn)continue;

          // Все углы внутри roadInner (гарантированно вне дороги)
          var riP=roadInnerRes.pts;
          if(riP.length>=3){
            var allInRoad=true;
            for(var ci4=0;ci4<4;ci4++){if(!ptIn(corners[ci4],riP)){allInRoad=false;break}}
            if(!allInRoad)continue;
          }

          // Не пересекает коннекторы (дорожные подключения)
          var hitsConn=false;
          if(connectors.length>0){
            for(var cci=0;cci<connectors.length&&!hitsConn;cci++){
              var ccn=connectors[cci];
              var ccdx=ccn.to.x-ccn.from.x,ccdy=ccn.to.y-ccn.from.y;
              var cclen=Math.sqrt(ccdx*ccdx+ccdy*ccdy);if(cclen<0.5)continue;
              var cpAx=-ccdy/cclen,cpAy=ccdx/cclen;
              var cmid=vec2((ccn.from.x+ccn.to.x)/2,(ccn.from.y+ccn.to.y)/2);
              var cbc=ccn.bufCen||cmid;
              var ctA=vec2(cmid.x+cpAx*3,cmid.y+cpAy*3);
              var ctB=vec2(cmid.x-cpAx*3,cmid.y-cpAy*3);
              var cti=(vLen(vSub(ctA,cbc))<vLen(vSub(ctB,cbc)))?1:-1;
              var cipx=cpAx*cti*6,cipy=cpAy*cti*6;
              var connQuad=[ccn.from,ccn.to,vec2(ccn.to.x+cipx,ccn.to.y+cipy),vec2(ccn.from.x+cipx,ccn.from.y+cipy)];
              // Проверка: ребро площадки × ребро коннектора
              for(var pe=0;pe<4&&!hitsConn;pe++){
                for(var qe=0;qe<4;qe++){
                  if(segSeg(corners[pe],corners[(pe+1)%4],connQuad[qe],connQuad[(qe+1)%4])){hitsConn=true;break}
                }
              }
              // Центр площадки внутри коннектора
              if(!hitsConn&&ptIn(center,connQuad))hitsConn=true;
            }
          }
          if(hitsConn)continue;

          // Внутри trashZone: внутри хотя бы одного trashOuter И вне всех trashInner
          var inOuter=false;
          for(var toi2=0;toi2<trashOuter.length;toi2++){if(ptIn(center,trashOuter[toi2])){inOuter=true;break}}
          if(!inOuter)continue;
          var inInner=false;
          for(var tii2=0;tii2<trashInner.length;tii2++){if(ptIn(center,trashInner[tii2])){inInner=true;break}}
          if(inInner)continue;

          // Не пересекает секции (все углы вне secFire)
          var hitsSec=false;
          for(var sfi=0;sfi<secFire.length&&!hitsSec;sfi++){
            for(var ci5=0;ci5<4;ci5++){if(ptIn(corners[ci5],secFire[sfi])){hitsSec=true;break}}
          }
          if(hitsSec)continue;

          // Расстояние от центра полигона (максимизируем)
          var dist2=vLen(vSub(center,cen2));
          if(dist2>bestDist){
            bestDist=dist2;
            trashPad={center:center,rect:corners};
          }
        }
      }

      // Буфер 20м от площадки
      if(trashPad){
        var pc=trashPad.center;
        trashPadBuf=[
          vAdd(pc,vAdd(vSc(d1,-(padW/2+20)),vSc(d2,-(padH/2+20)))),
          vAdd(pc,vAdd(vSc(d1,(padW/2+20)),vSc(d2,-(padH/2+20)))),
          vAdd(pc,vAdd(vSc(d1,(padW/2+20)),vSc(d2,(padH/2+20)))),
          vAdd(pc,vAdd(vSc(d1,-(padW/2+20)),vSc(d2,(padH/2+20))))
        ];
      }
    }

    setComp({p:p,grid:grid,edges:withSecs,secFire:secFire,roadBuf:roadBuf,obb:obb,
      roadOuter:roadOuterRes.pts,roadInner:roadInnerRes.pts,connectors:connectors,
      graphNodes:graphNodes,graphEdges:graphEdges,trashInner:trashInner,trashOuter:trashOuter,
      trashPad:trashPad,trashPadBuf:trashPadBuf,
      playBuf12:playBuf12,playBuf20:playBuf20,playBuf40:playBuf40});
    setErr(null);
    }catch(ex){setErr(ex.message);console.error(ex)}
  },[poly,gridStep,sw,fb,eb,ib,latL,lonL,tg,ctxRoll,typo,ctxOverride]);

  /* DRAW */
  var draw=useCallback(function(){
    var cv=cvRef.current;if(!cv)return;
    var c=cv.getContext("2d");c.clearRect(0,0,CW,CH);
    var cam=camRef.current;
    var ws=function(pt){return w2s(cam,pt.x,pt.y,CW,CH)};

    var tl=s2w(cam,0,0,CW,CH),br=s2w(cam,CW,CH,CW,CH);
    var wmx=Math.min(tl.x,br.x),wMx=Math.max(tl.x,br.x),wmy=Math.min(tl.y,br.y),wMy=Math.max(tl.y,br.y);
    var bs=cam.z>2?10:cam.z>0.8?50:100;
    c.strokeStyle="rgba(200,205,215,0.4)";c.lineWidth=0.5;
    for(var x=Math.floor(wmx/bs)*bs;x<=wMx;x+=bs){var a=ws(vec2(x,wmy)),b=ws(vec2(x,wMy));c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.stroke()}
    for(var y=Math.floor(wmy/bs)*bs;y<=wMy;y+=bs){var a2=ws(vec2(wmx,y)),b2=ws(vec2(wMx,y));c.beginPath();c.moveTo(a2.x,a2.y);c.lineTo(b2.x,b2.y);c.stroke()}

    var scM=cam.z<1?100:cam.z<2.5?50:cam.z<6?20:10;var scPx=scM*cam.z;
    c.strokeStyle="#264653";c.lineWidth=2;c.beginPath();c.moveTo(20,CH-18);c.lineTo(20+scPx,CH-18);c.stroke();
    c.fillStyle="#264653";c.font="bold 10px monospace";c.textAlign="center";c.fillText(scM+"м",20+scPx/2,CH-24);

    if(mode==="draw"){
      if(dPts.length>0){c.beginPath();var p0=ws(dPts[0]);c.moveTo(p0.x,p0.y);for(var di=1;di<dPts.length;di++){var dp=ws(dPts[di]);c.lineTo(dp.x,dp.y)}if(mw){var m=ws(mw);c.lineTo(m.x,m.y)}c.strokeStyle="#457b9d";c.lineWidth=2;c.stroke();
        if(mw&&dPts.length>=3&&vLen(vSub(mw,dPts[0]))<8/cam.z){c.beginPath();c.arc(p0.x,p0.y,14,0,Math.PI*2);c.strokeStyle="#2a9d8f";c.lineWidth=2.5;c.stroke()}
        for(var di2=0;di2<dPts.length;di2++){var sp=ws(dPts[di2]);c.beginPath();c.arc(sp.x,sp.y,5,0,Math.PI*2);c.fillStyle="#e63946";c.fill();c.strokeStyle="#fff";c.lineWidth=1.5;c.stroke()}
        for(var di3=0;di3<dPts.length-1;di3++){var ea=ws(dPts[di3]),eb2=ws(dPts[di3+1]);c.fillStyle="rgba(29,53,87,0.85)";c.font="bold 10px monospace";c.textAlign="center";c.fillText(vLen(vSub(dPts[di3+1],dPts[di3])).toFixed(1)+"м",(ea.x+eb2.x)/2,(ea.y+eb2.y)/2-8)}
      }
      if(mw){var ms=ws(mw);c.fillStyle="#264653";c.font="11px monospace";c.textAlign="left";c.fillText("("+mw.x.toFixed(1)+", "+mw.y.toFixed(1)+")",ms.x+12,ms.y-8)}
      return;
    }

    if(!comp)return;
    var pp=comp.p,grid=comp.grid,edges=comp.edges,secFire=comp.secFire,obb=comp.obb;var s;

    // OBB outline
    if(obb){
      var d1=obb.d1,d2=obb.d2,cen=vec2(obb.cx,obb.cy);
      var hw=obb.w/2,hh=obb.h/2;
      var corners=[
        vAdd(vAdd(cen,vSc(d1,-hw)),vSc(d2,-hh)),
        vAdd(vAdd(cen,vSc(d1,hw)),vSc(d2,-hh)),
        vAdd(vAdd(cen,vSc(d1,hw)),vSc(d2,hh)),
        vAdd(vAdd(cen,vSc(d1,-hw)),vSc(d2,hh))
      ];
      c.beginPath();var c0=ws(corners[0]);c.moveTo(c0.x,c0.y);
      for(var oi=1;oi<4;oi++){var cp=ws(corners[oi]);c.lineTo(cp.x,cp.y)}
      c.closePath();c.setLineDash([6,4]);c.strokeStyle="rgba(100,80,160,0.35)";c.lineWidth=1;c.stroke();c.setLineDash([]);
    }

    c.beginPath();s=ws(pp[0]);c.moveTo(s.x,s.y);for(var pi=1;pi<pp.length;pi++){s=ws(pp[pi]);c.lineTo(s.x,s.y)}c.closePath();c.fillStyle="rgba(180,210,240,0.12)";c.fill();c.strokeStyle="#2a4a6b";c.lineWidth=2.5;c.stroke();

    // Пожарный проезд — offscreen canvas для объединения без дырок
    if(vRoad&&comp.roadOuter&&comp.roadOuter.length>=3&&comp.roadInner&&comp.roadInner.length>=3){
      var ro=comp.roadOuter,ri=comp.roadInner;

      // Offscreen canvas: рисуем все дороги solid, потом вырезаем inner
      var oc=document.createElement("canvas");oc.width=CW;oc.height=CH;
      var ox=oc.getContext("2d");

      // Clip offscreen to polygon
      ox.beginPath();s=ws(pp[0]);ox.moveTo(s.x,s.y);for(var ri2=1;ri2<pp.length;ri2++){s=ws(pp[ri2]);ox.lineTo(s.x,s.y)}ox.closePath();ox.clip();

      ox.fillStyle="rgb(140,140,155)";

      // Ring road outer fill
      ox.beginPath();s=ws(ro[0]);ox.moveTo(s.x,s.y);for(var roi=1;roi<ro.length;roi++){s=ws(ro[roi]);ox.lineTo(s.x,s.y)}ox.closePath();ox.fill();

      // Connector rects
      if(comp.connectors){
        for(var cni=0;cni<comp.connectors.length;cni++){
          var cn=comp.connectors[cni];
          var cdx=cn.to.x-cn.from.x,cdy=cn.to.y-cn.from.y;
          var clen=Math.sqrt(cdx*cdx+cdy*cdy);if(clen<0.5)continue;
          var pAx=-cdy/clen,pAy=cdx/clen;
          var midCn=vec2((cn.from.x+cn.to.x)/2,(cn.from.y+cn.to.y)/2);
          var bc=cn.bufCen||midCn;
          var testA=vec2(midCn.x+pAx*3,midCn.y+pAy*3);
          var testB=vec2(midCn.x-pAx*3,midCn.y-pAy*3);
          var toInner=(vLen(vSub(testA,bc))<vLen(vSub(testB,bc)))?1:-1;
          var ipx=pAx*toInner*6,ipy=pAy*toInner*6;
          ox.beginPath();
          s=ws(cn.from);ox.moveTo(s.x,s.y);
          s=ws(cn.to);ox.lineTo(s.x,s.y);
          s=ws(vec2(cn.to.x+ipx,cn.to.y+ipy));ox.lineTo(s.x,s.y);
          s=ws(vec2(cn.from.x+ipx,cn.from.y+ipy));ox.lineTo(s.x,s.y);
          ox.closePath();ox.fill();
        }
      }

      // Вырезаем road inner (дыра двора)
      ox.globalCompositeOperation="destination-out";
      ox.fillStyle="rgb(0,0,0)";
      ox.beginPath();s=ws(ri[0]);ox.moveTo(s.x,s.y);for(var rii=1;rii<ri.length;rii++){s=ws(ri[rii]);ox.lineTo(s.x,s.y)}ox.closePath();ox.fill();

      // Рисуем offscreen → main canvas с прозрачностью
      c.save();c.globalAlpha=0.45;c.drawImage(oc,0,0);c.globalAlpha=1.0;c.restore();

      // Контуры на основном canvas
      c.save();
      c.beginPath();s=ws(pp[0]);c.moveTo(s.x,s.y);for(var pci=1;pci<pp.length;pci++){s=ws(pp[pci]);c.lineTo(s.x,s.y)}c.closePath();c.clip();
      c.beginPath();s=ws(ro[0]);c.moveTo(s.x,s.y);for(var roi2=1;roi2<ro.length;roi2++){s=ws(ro[roi2]);c.lineTo(s.x,s.y)}c.closePath();c.strokeStyle="rgba(120,120,130,0.35)";c.lineWidth=0.7;c.stroke();
      c.beginPath();s=ws(ri[0]);c.moveTo(s.x,s.y);for(var rii2=1;rii2<ri.length;rii2++){s=ws(ri[rii2]);c.lineTo(s.x,s.y)}c.closePath();c.strokeStyle="rgba(120,120,130,0.25)";c.lineWidth=0.7;c.setLineDash([3,3]);c.stroke();c.setLineDash([]);

      // Точки пересечения
      if(comp.connectors){
        for(var cni2=0;cni2<comp.connectors.length;cni2++){
          var cn2=comp.connectors[cni2];
          var pf=ws(cn2.from),pt2=ws(cn2.to);
          c.beginPath();c.arc(pf.x,pf.y,4,0,Math.PI*2);c.fillStyle="#2080e0";c.fill();c.strokeStyle="#fff";c.lineWidth=1;c.stroke();
          c.beginPath();c.arc(pt2.x,pt2.y,4,0,Math.PI*2);c.fillStyle="#e07020";c.fill();c.strokeStyle="#fff";c.lineWidth=1;c.stroke();
        }
      }
      c.restore();
    }

    if(vYard&&secFire&&secFire.length>0){var rPx=fb*0.7*cam.z;c.save();c.beginPath();s=ws(pp[0]);c.moveTo(s.x,s.y);for(var yi=1;yi<pp.length;yi++){s=ws(pp[yi]);c.lineTo(s.x,s.y)}c.closePath();c.clip();
      c.beginPath();c.rect(0,0,CW,CH);for(var fi=0;fi<secFire.length;fi++)roundQuad(c,secFire[fi].map(ws),rPx,true);c.fillStyle="rgba(76,187,97,0.35)";c.fill("evenodd");c.restore()}

    // Буфер мусорных контейнеров: разность 100м − 20м
    if(vTrash&&comp.trashOuter&&comp.trashOuter.length>0){
      var tc=document.createElement("canvas");tc.width=CW;tc.height=CH;
      var tx=tc.getContext("2d");
      tx.beginPath();s=ws(pp[0]);tx.moveTo(s.x,s.y);for(var tpi=1;tpi<pp.length;tpi++){s=ws(pp[tpi]);tx.lineTo(s.x,s.y)}tx.closePath();tx.clip();
      var rOut=100*0.3*cam.z,rIn=20*0.5*cam.z;
      // Fill 100м буферы (скруглённые)
      tx.fillStyle="rgb(180,120,60)";
      for(var toi=0;toi<comp.trashOuter.length;toi++){tx.beginPath();roundQuad(tx,comp.trashOuter[toi].map(ws),rOut,true);tx.fill()}
      // Вырезаем 20м буферы (скруглённые)
      tx.globalCompositeOperation="destination-out";
      tx.fillStyle="rgb(0,0,0)";
      for(var tii=0;tii<comp.trashInner.length;tii++){tx.beginPath();roundQuad(tx,comp.trashInner[tii].map(ws),rIn,true);tx.fill()}
      c.save();c.globalAlpha=0.15;c.drawImage(tc,0,0);c.globalAlpha=1.0;c.restore();
    }

    // Контейнерная площадка 6×3 + буфер 20м
    if(vTrash&&comp.trashPad){
      var tp=comp.trashPad;
      // Буфер 20м (скруглённый)
      if(comp.trashPadBuf){
        var tbr=comp.trashPadBuf.map(ws);
        var tpbR=20*0.5*cam.z;
        c.beginPath();roundQuad(c,tbr,tpbR,true);
        c.fillStyle="rgba(220,160,40,0.12)";c.fill();
        c.setLineDash([4,3]);c.strokeStyle="rgba(200,140,30,0.4)";c.lineWidth=1;c.stroke();c.setLineDash([]);
      }
      // Площадка 6×3
      var tpr=tp.rect.map(ws);
      c.beginPath();c.moveTo(tpr[0].x,tpr[0].y);c.lineTo(tpr[1].x,tpr[1].y);c.lineTo(tpr[2].x,tpr[2].y);c.lineTo(tpr[3].x,tpr[3].y);c.closePath();
      c.fillStyle="rgba(200,140,30,0.7)";c.fill();c.strokeStyle="#8b5e14";c.lineWidth=1.5;c.stroke();
      // Метка
      if(vLab){var tpc=ws(tp.center);c.font="bold 9px monospace";c.textAlign="center";c.textBaseline="middle";c.fillStyle="#fff";c.fillText("ТКО",tpc.x,tpc.y)}
    }

    // Детские площадки: 3 зоны
    if(vPlay&&comp.playBuf12&&comp.playBuf12.length>0){
      var pb12=comp.playBuf12,pb20=comp.playBuf20,pb40=comp.playBuf40;
      // Скругления пропорционально расстоянию
      var r12=12*0.4*cam.z,r20=20*0.4*cam.z,r40=40*0.3*cam.z;

      // Зона 1: 12-20м, вычитаем ТКО 20м буфер (синяя)
      var pc1=document.createElement("canvas");pc1.width=CW;pc1.height=CH;
      var px1=pc1.getContext("2d");
      px1.beginPath();s=ws(pp[0]);px1.moveTo(s.x,s.y);for(var pp1=1;pp1<pp.length;pp1++){s=ws(pp[pp1]);px1.lineTo(s.x,s.y)}px1.closePath();px1.clip();
      px1.fillStyle="rgb(66,133,244)";
      for(var pi4=0;pi4<pb20.length;pi4++){px1.beginPath();roundQuad(px1,pb20[pi4].map(ws),r20,true);px1.fill()}
      px1.globalCompositeOperation="destination-out";px1.fillStyle="rgb(0,0,0)";
      for(var pi5=0;pi5<pb12.length;pi5++){px1.beginPath();roundQuad(px1,pb12[pi5].map(ws),r12,true);px1.fill()}
      // Вычитаем ТКО 20м буфер
      if(comp.trashPadBuf){var tpbs=comp.trashPadBuf.map(ws);var tpbr=20*0.5*cam.z;px1.beginPath();roundQuad(px1,tpbs,tpbr,true);px1.fill()}
      c.save();c.globalAlpha=0.12;c.drawImage(pc1,0,0);c.globalAlpha=1.0;c.restore();

      // Зона 2: 20-40м (зелёная)
      var pc2=document.createElement("canvas");pc2.width=CW;pc2.height=CH;
      var px2=pc2.getContext("2d");
      px2.beginPath();s=ws(pp[0]);px2.moveTo(s.x,s.y);for(var pp2=1;pp2<pp.length;pp2++){s=ws(pp[pp2]);px2.lineTo(s.x,s.y)}px2.closePath();px2.clip();
      px2.fillStyle="rgb(52,168,83)";
      for(var pi6=0;pi6<pb40.length;pi6++){px2.beginPath();roundQuad(px2,pb40[pi6].map(ws),r40,true);px2.fill()}
      px2.globalCompositeOperation="destination-out";px2.fillStyle="rgb(0,0,0)";
      for(var pi7=0;pi7<pb20.length;pi7++){px2.beginPath();roundQuad(px2,pb20[pi7].map(ws),r20,true);px2.fill()}
      c.save();c.globalAlpha=0.12;c.drawImage(pc2,0,0);c.globalAlpha=1.0;c.restore();

      // Зона 3: 40м+ (оранжевая)
      var pc3=document.createElement("canvas");pc3.width=CW;pc3.height=CH;
      var px3=pc3.getContext("2d");
      px3.beginPath();s=ws(pp[0]);px3.moveTo(s.x,s.y);for(var pp3=1;pp3<pp.length;pp3++){s=ws(pp[pp3]);px3.lineTo(s.x,s.y)}px3.closePath();px3.clip();
      px3.fillStyle="rgb(234,67,53)";px3.fillRect(0,0,CW,CH);
      px3.globalCompositeOperation="destination-out";px3.fillStyle="rgb(0,0,0)";
      for(var pi8=0;pi8<pb40.length;pi8++){px3.beginPath();roundQuad(px3,pb40[pi8].map(ws),r40,true);px3.fill()}
      c.save();c.globalAlpha=0.08;c.drawImage(pc3,0,0);c.globalAlpha=1.0;c.restore();
    }

    if(vGrid){c.lineWidth=0.7;c.strokeStyle="rgba(100,140,200,0.22)";for(var gi2=0;gi2<grid.h.length;gi2++){var ga=ws(grid.h[gi2].start),gb=ws(grid.h[gi2].end);c.beginPath();c.moveTo(ga.x,ga.y);c.lineTo(gb.x,gb.y);c.stroke()}
      c.strokeStyle="rgba(100,200,140,0.22)";for(var gj=0;gj<grid.v.length;gj++){var ga2=ws(grid.v[gj].start),gb2=ws(grid.v[gj].end);c.beginPath();c.moveTo(ga2.x,ga2.y);c.lineTo(gb2.x,gb2.y);c.stroke()}}

    if(vBuf){var rI=ib*0.3*cam.z,rE=eb*0.5*cam.z,rF=fb*0.7*cam.z;
      for(var bi=0;bi<edges.length;bi++){var be=edges[bi];if(!be.bufs)continue;
        c.beginPath();roundQuad(c,be.bufs.insol.map(ws),rI,true);c.fillStyle="rgba(255,235,59,0.07)";c.fill();
        c.beginPath();roundQuad(c,be.bufs.end.map(ws),rE,true);c.fillStyle="rgba(156,39,176,0.07)";c.fill();
        c.beginPath();roundQuad(c,be.bufs.fire.map(ws),rF,true);c.fillStyle="rgba(76,175,80,0.07)";c.fill()}}

    // Дорожный буфер 14м — контуры (светло-серые)
    if(vRoad&&comp.roadBuf){
      for(var dbi=0;dbi<comp.roadBuf.length;dbi++){
        var dbr=comp.roadBuf[dbi].map(ws);
        c.beginPath();c.moveTo(dbr[0].x,dbr[0].y);c.lineTo(dbr[1].x,dbr[1].y);c.lineTo(dbr[2].x,dbr[2].y);c.lineTo(dbr[3].x,dbr[3].y);c.closePath();
        c.strokeStyle="rgba(180,180,190,0.6)";c.lineWidth=1;c.setLineDash([4,3]);c.stroke();c.setLineDash([]);
      }
    }

    if(vGhost)for(var ghi=0;ghi<edges.length;ghi++){var ge=edges[ghi];if(ge.trimmed&&ge.origStart){var ga3=ws(ge.origStart),gb3=ws(ge.origEnd);c.beginPath();c.moveTo(ga3.x,ga3.y);c.lineTo(gb3.x,gb3.y);c.setLineDash([4,4]);c.strokeStyle="rgba(150,150,150,0.3)";c.lineWidth=1;c.stroke();c.setLineDash([])}}

    if(vSec)for(var sei=0;sei<edges.length;sei++){var se=edges[sei];if(!se.secs||!se.secs.length)continue;var ci2=CC[se.context]||CC[2];
      for(var sj=0;sj<se.secs.length;sj++){var sec=se.secs[sj];var r=sec.rect.map(ws);
        c.beginPath();c.moveTo(r[0].x,r[0].y);c.lineTo(r[1].x,r[1].y);c.lineTo(r[2].x,r[2].y);c.lineTo(r[3].x,r[3].y);c.closePath();
        if(sec.isGap){c.fillStyle="rgba(200,200,200,0.3)";c.fill();c.setLineDash([3,3]);c.strokeStyle="rgba(100,100,100,0.3)";c.lineWidth=1;c.stroke();c.setLineDash([])}
        else{var secCol=sec.isTower?"rgba(140,80,200,0.6)":ci2.f;var secStk=sec.isTower?"#6b3fa0":"#1d3557";
          c.fillStyle=sec.BAD?"rgba(255,0,0,0.6)":secCol;c.fill();c.strokeStyle=sec.BAD?"#ff0000":secStk;c.lineWidth=sec.BAD?3:1.5;c.stroke();
          if(vLab){var cx=(r[0].x+r[1].x+r[2].x+r[3].x)/4,cy=(r[0].y+r[1].y+r[2].y+r[3].y)/4;var tx=sec.BAD?"!"+sec.length.toFixed(1):sec.isTower?sec.length.toFixed(1)+"×23":sec.length.toFixed(0)+"м";c.font="bold "+(sec.isTower?"9":"10")+"px monospace";c.textAlign="center";c.textBaseline="middle";var tw=c.measureText(tx).width+6;c.fillStyle=sec.BAD?"rgba(200,0,0,0.9)":sec.isTower?"rgba(100,40,160,0.9)":"rgba(29,53,87,0.85)";c.fillRect(cx-tw/2,cy-7,tw,14);c.fillStyle="#fff";c.fillText(tx,cx,cy)}}}}

    if(vAx)for(var ai=0;ai<edges.length;ai++){var ae=edges[ai];if(ae.length<1)continue;var ci3=CC[ae.context]||CC[2];
      var aa=ws(ae.start),ab=ws(ae.end);c.beginPath();c.moveTo(aa.x,aa.y);c.lineTo(ab.x,ab.y);c.strokeStyle=ci3.m;c.lineWidth=3;c.stroke();
      if(vLab){var mx=(aa.x+ab.x)/2,my=(aa.y+ab.y)/2;var ori=ae.orientation===0?"Ш":"М";var st=ae.secTag?"["+ae.secTag+"]":"";var tr=ae.origLen?" \u2190"+ae.origLen.toFixed(0):"";var lb=ae.id+" "+ori+st+" "+ae.length.toFixed(0)+"м"+tr;c.font="bold 10px monospace";var tw2=c.measureText(lb).width+8;c.fillStyle="rgba(255,255,255,0.92)";c.fillRect(mx-tw2/2,my-20,tw2,16);c.strokeStyle=ci3.m;c.lineWidth=1;c.strokeRect(mx-tw2/2,my-20,tw2,16);c.fillStyle=ci3.m;c.textAlign="center";c.textBaseline="middle";c.fillText(lb,mx,my-12)}}

    // Граф дорожной сети
    if(vGraph&&comp.graphNodes&&comp.graphEdges){
      var gn=comp.graphNodes,ge2=comp.graphEdges;
      // Рёбра
      for(var gei2=0;gei2<ge2.length;gei2++){
        var edge2=ge2[gei2];
        var ga=ws(gn[edge2.a].pt),gb=ws(gn[edge2.b].pt);
        c.beginPath();c.moveTo(ga.x,ga.y);c.lineTo(gb.x,gb.y);
        if(edge2.type==="ring"){c.strokeStyle="rgba(0,180,160,0.7)";c.lineWidth=2}
        else{c.strokeStyle="rgba(220,120,30,0.8)";c.lineWidth=2}
        c.stroke();
      }
      // Узлы
      for(var gni2=0;gni2<gn.length;gni2++){
        var nd=gn[gni2],ns=ws(nd.pt);
        var rad=3;var col="#00b4a0";
        if(nd.type==="junction"){rad=5;col="#ff6600"}
        else if(nd.type==="boundary"){rad=5;col="#2080e0"}
        c.beginPath();c.arc(ns.x,ns.y,rad,0,Math.PI*2);
        c.fillStyle=col;c.fill();c.strokeStyle="#fff";c.lineWidth=1;c.stroke();
      }
    }

    for(var vi=0;vi<pp.length;vi++){s=ws(pp[vi]);c.beginPath();c.arc(s.x,s.y,4,0,Math.PI*2);c.fillStyle="#264653";c.fill();c.strokeStyle="#fff";c.lineWidth=1.5;c.stroke()}
    c.fillStyle="rgba(38,70,83,0.5)";c.font="10px monospace";c.textAlign="right";c.fillText(cam.z.toFixed(1)+" px/m",CW-10,CH-8);
  },[mode,dPts,mw,comp,vGrid,vBuf,vSec,vAx,vLab,vGhost,vYard,vRoad,vGraph,vTrash,vPlay,fb,eb,ib,ct]);

  useEffect(function(){draw()},[draw]);

  var gwp=function(e){var r=cvRef.current.getBoundingClientRect();var sx=(e.clientX-r.left)*(CW/r.width),sy=(e.clientY-r.top)*(CH/r.height);var w=s2w(camRef.current,sx,sy,CW,CH);return{sx:sx,sy:sy,x:w.x,y:w.y}};
  var onClick=function(e){if(panRef.current&&panRef.current.moved)return;if(mode!=="draw")return;var w=gwp(e);if(dPts.length>=3&&vLen(vSub(vec2(w.x,w.y),dPts[0]))<8/camRef.current.z){var p=makeCCW(dPts.slice());setPoly(p);setDPts([]);setMode("view");camRef.current=fitCam(p,CW,CH);setCt(function(t){return t+1});return}setDPts(function(pr){return pr.concat([vec2(w.x,w.y)])})};
  var onDown=function(e){if(e.button===1||e.button===2||(e.button===0&&e.shiftKey)){e.preventDefault();panRef.current={sx:e.clientX,sy:e.clientY,cx:camRef.current.cx,cy:camRef.current.cy,moved:false}}else{panRef.current={moved:false}}};
  var onMove=function(e){var w=gwp(e);setMw(vec2(w.x,w.y));if(panRef.current&&panRef.current.sx!==undefined){var dx=e.clientX-panRef.current.sx,dy=e.clientY-panRef.current.sy;if(Math.abs(dx)>2||Math.abs(dy)>2)panRef.current.moved=true;var r=cvRef.current.getBoundingClientRect();camRef.current.cx=panRef.current.cx-(dx*CW/r.width)/camRef.current.z;camRef.current.cy=panRef.current.cy+(dy*CH/r.height)/camRef.current.z;setCt(function(t){return t+1})}};
  var onUp=function(){if(panRef.current&&panRef.current.moved)setTimeout(function(){panRef.current=null},10);else panRef.current=null};
  var onWheel=function(e){e.preventDefault();var r=cvRef.current.getBoundingClientRect();var sx=(e.clientX-r.left)*(CW/r.width),sy=(e.clientY-r.top)*(CH/r.height);var wb=s2w(camRef.current,sx,sy,CW,CH);camRef.current.z=Math.max(0.2,Math.min(40,camRef.current.z*(e.deltaY<0?1.15:1/1.15)));var wa=s2w(camRef.current,sx,sy,CW,CH);camRef.current.cx-=(wa.x-wb.x);camRef.current.cy-=(wa.y-wb.y);setCt(function(t){return t+1})};

  var doOptimize=function(){
    if(!poly||poly.length<3)return;
    var p2=makeCCW(poly);
    var ll2=pL(latL),lo2=pL(lonL);
    if(!ll2.length||!lo2.length)return;
    var par2={sw:sw,fire:fb,endB:eb,insol:ib};
    var baseEdges=extractEdges(p2);baseEdges=classOri(baseEdges);
    var best=autoOptimize(baseEdges,p2,par2,ll2,lo2,sw,tg);
    if(best){setCtxOverride(best);setCtxRoll(-1)}
  };
  var loadP=function(n){var pts=PR[n];if(!pts)return;var p=makeCCW(pts.slice());setPoly(p);setDPts([]);setMode("view");setCtxRoll(0);setCtxOverride(null);camRef.current=fitCam(p,CW,CH);setCt(function(t){return t+1})};
  var reset=function(){setPoly(null);setDPts([]);setMode("draw");setComp(null);setCtxRoll(0);setCtxOverride(null);camRef.current=makeCam(100,80,3.5);setCt(function(t){return t+1})};

  var stats=comp?function(){var ts=0,tl=0,inv=0,lS=0,mS=0,tow=0,d={};
    for(var i=0;i<comp.edges.length;i++){var e=comp.edges[i];if(!e.secs)continue;for(var j=0;j<e.secs.length;j++){var s=e.secs[j];if(s.isGap)continue;ts++;tl+=s.length;d[s.length]=(d[s.length]||0)+1;if(s.BAD)inv++;if(s.isTower)tow++;else if(e.secTag==="ш")lS++;else mS++}}
    return{ts:ts,tl:tl,d:d,inv:inv,lS:lS,mS:mS,tow:tow,ax:comp.edges.filter(function(e){return e.secs&&e.secs.length>0}).length,tr:comp.edges.filter(function(e){return e.trimmed&&!e.removed}).length,rm:comp.edges.filter(function(e){return e.removed}).length,cn:comp.connectors?comp.connectors.length:0}}():null;
  var area=poly&&poly.length>=3?Math.abs(pArea(makeCCW(poly))):0;

  var bS={padding:"3px 8px",fontSize:10,borderRadius:3,border:"1px solid rgba(255,255,255,0.25)",background:"rgba(255,255,255,0.08)",color:"#f1faee",cursor:"pointer",fontFamily:"inherit"};

  return(
    <div style={{width:"100%",minHeight:"100vh",background:"#f4f5f7",fontFamily:"'JetBrains Mono','Fira Code',monospace",color:"#264653",display:"flex",flexDirection:"column"}}>
      <div style={{padding:"10px 16px",background:"linear-gradient(135deg,#1d3557,#264653)",color:"#f1faee",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:18,fontWeight:800,letterSpacing:2}}>U·B·SYSTEM</span>
          <span style={{fontSize:10,opacity:0.6,borderLeft:"1px solid rgba(255,255,255,0.2)",paddingLeft:8}}>{"v6 · "+(typo===0?"секции":"башня+С")+" · insol="+ib+"м"}</span>
        </div>
        <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
          {Object.keys(PR).map(function(n){return <button key={n} onClick={function(){loadP(n)}} style={bS}>{n}</button>})}
          <button onClick={function(){camRef.current=poly&&poly.length>=3?fitCam(makeCCW(poly),CW,CH):camRef.current;setCt(function(t){return t+1})}} style={Object.assign({},bS,{borderColor:"#2a9d8f"})}>Вписать</button>
          <button onClick={function(){setTypo(0)}} style={Object.assign({},bS,typo===0?{borderColor:"#2a9d8f",background:"rgba(42,157,143,0.3)"}:{})}>Секции</button>
          <button onClick={function(){setTypo(1)}} style={Object.assign({},bS,typo===1?{borderColor:"#8b5cf6",background:"rgba(139,92,246,0.3)"}:{})}>Башня+С</button>
          <button onClick={function(){setCtxOverride(null);setCtxRoll(function(r){return r+1})}} style={Object.assign({},bS,{borderColor:"#f4a261",background:"rgba(244,162,97,0.2)",fontWeight:700})}>{"Перебор #"+ctxRoll}</button>
          <button onClick={doOptimize} style={Object.assign({},bS,{borderColor:"#10b981",background:ctxOverride?"rgba(16,185,129,0.3)":"rgba(16,185,129,0.1)",fontWeight:700})}>{"Авто"+(ctxOverride?" ✓":"")}</button>
          <button onClick={reset} style={Object.assign({},bS,{borderColor:"#e63946",background:"rgba(230,57,70,0.15)"})}>Сброс</button>
        </div>
      </div>
      {err && <div style={{padding:8,background:"#fee",color:"#c00",fontSize:12,fontWeight:700}}>{"Error: "+err}</div>}
      <div style={{display:"flex",flex:1,minHeight:0}}>
        <div style={{width:240,minWidth:240,padding:"10px 12px",background:"#fff",borderRight:"1px solid #e0e0e0",overflowY:"auto",fontSize:11}}>
          <STitle text="Параметры"/>
          <Sli l="Шаг сетки" v={gridStep} s={setGridStep} mn={3} mx={24} st={0.1} u="м"/>
          <Sli l="Ширина секции" v={sw} s={setSw} mn={10} mx={30} st={1} u="м"/>
          <Sli l="Пожарный" v={fb} s={setFb} mn={6} mx={30} st={1} u="м"/>
          <Sli l="Торцевой" v={eb} s={setEb} mn={10} mx={40} st={1} u="м"/>
          <Sli l="Инсоляция" v={ib} s={setIb} mn={10} mx={80} st={1} u="м"/>
          <Sli l="Gap" v={tg} s={setTg} mn={15} mx={40} st={1} u="м"/>
          <div style={{marginTop:8}}>
            <label style={{fontWeight:600,display:"block",marginBottom:2}}>{"Широтные [ш] (м)"}</label>
            <input value={latL} onChange={function(e){setLatL(e.target.value)}} style={{width:"100%",padding:"3px 5px",fontSize:11,border:"1px solid #ccc",borderRadius:3,fontFamily:"inherit",boxSizing:"border-box"}}/>
          </div>
          <div style={{marginTop:4}}>
            <label style={{fontWeight:600,display:"block",marginBottom:2}}>{"Меридиональные [м] (м)"}</label>
            <input value={lonL} onChange={function(e){setLonL(e.target.value)}} style={{width:"100%",padding:"3px 5px",fontSize:11,border:"1px solid #ccc",borderRadius:3,fontFamily:"inherit",boxSizing:"border-box"}}/>
          </div>
          <STitle text="Слои" mt={10}/>
          <Tog l="Сетка" v={vGrid} s={setVGrid}/><Tog l="Оси" v={vAx} s={setVAx}/>
          <Tog l="Буферы" v={vBuf} s={setVBuf}/><Tog l="Секции" v={vSec} s={setVSec}/>
          <Tog l="Метки" v={vLab} s={setVLab}/><Tog l="Призраки" v={vGhost} s={setVGhost}/>
          <Tog l="Двор" v={vYard} s={setVYard}/>
          <Tog l="Проезд" v={vRoad} s={setVRoad}/>
          <Tog l="Граф" v={vGraph} s={setVGraph}/>
          <Tog l="ТКО" v={vTrash} s={setVTrash}/>
          <Tog l="Дет.пл." v={vPlay} s={setVPlay}/>
          <STitle text="Легенда" mt={10}/>
          {[0,1,2].map(function(i){return <div key={i} style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}><div style={{width:14,height:4,background:CC[i].m}}/><span>{CC[i].l}</span></div>})}
          <div style={{display:"flex",alignItems:"center",gap:6,marginTop:3,marginBottom:2}}><div style={{width:14,height:8,background:"rgba(160,160,170,0.4)",border:"1px solid rgba(120,120,130,0.4)"}}/><span>Проезд 6м</span></div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}><div style={{width:14,height:8,background:"rgba(140,80,200,0.6)",border:"1px solid #6b3fa0"}}/><span>Башня 23.1м</span></div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}><div style={{width:14,height:8,background:"rgba(180,120,60,0.2)",border:"1px solid rgba(180,120,60,0.4)"}}/><span>ТКО 20-100м</span></div>
          <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:2}}>
            <div style={{width:10,height:8,background:"rgba(66,133,244,0.2)"}}/><span style={{fontSize:10}}>12-20</span>
            <div style={{width:10,height:8,background:"rgba(52,168,83,0.2)"}}/>
            <span style={{fontSize:10}}>20-40</span>
            <div style={{width:10,height:8,background:"rgba(234,67,53,0.15)"}}/>
            <span style={{fontSize:10}}>40+м</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}><div style={{width:14,height:8,border:"1px dashed rgba(180,180,190,0.8)"}}/><span>Буфер 14м</span></div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}><div style={{width:8,height:8,borderRadius:4,background:"#2080e0"}}/><span>Полигон</span><div style={{width:8,height:8,borderRadius:4,background:"#e07020",marginLeft:4}}/><span>Дорога (внутр.)</span></div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}><div style={{width:14,height:3,background:"rgba(0,180,160,0.7)"}}/><span>Кольцо</span><div style={{width:14,height:3,background:"rgba(220,120,30,0.7)",marginLeft:4}}/><span>Подключ.</span></div>
          {area>0 && <div style={{marginTop:8,padding:5,background:"#eef2f7",borderRadius:4,fontSize:10}}>{"S = "+area.toFixed(0)+" м² ("+(area/10000).toFixed(2)+" га)"}</div>}
          {stats && <div style={{marginTop:6,padding:5,background:"#eef2f7",borderRadius:4}}>
            <STitle text="Статистика"/>
            <div>{"Осей: "+stats.ax+" · Подрезано: "+stats.tr+" · Удалено: "+stats.rm}</div>
            <div>{"Секций: "+stats.ts+" ([ш]"+stats.lS+" [м]"+stats.mS+(stats.tow?" [Б]"+stats.tow:"")+")"}</div>
            <div>{"Длина: "+stats.tl.toFixed(0)+"м · Подключений: "+stats.cn}</div>
            {stats.inv>0 && <div style={{color:"#e63946",fontWeight:700}}>{"⚠ НЕВАЛИДНЫХ: "+stats.inv}</div>}
            <div style={{marginTop:2,fontSize:10}}>{Object.keys(stats.d).sort(function(a,b){return +b-+a}).map(function(l){return <span key={l} style={{display:"inline-block",marginRight:3,padding:"1px 3px",background:"#dde5ed",borderRadius:3}}>{(+l).toFixed(0)+"м×"+stats.d[l]}</span>})}</div>
          </div>}
          <div style={{marginTop:10,fontSize:10,color:"#999",lineHeight:1.4}}>{"Колёсико = зум · Shift+drag / ПКМ = пан"}</div>
        </div>
        <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:12}}>
          {mode==="draw"&&!poly && <div style={{marginBottom:6,fontSize:11,color:"#666",textAlign:"center"}}>Кликайте для вершин · замкните по первой точке · или пресет</div>}
          <canvas ref={cvRef} width={CW} height={CH}
            onClick={onClick} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp}
            onMouseLeave={function(){setMw(null);panRef.current=null}}
            onWheel={onWheel} onContextMenu={function(e){e.preventDefault()}}
            style={{border:"2px solid #264653",borderRadius:6,cursor:mode==="draw"?"crosshair":"grab",background:"#fff",maxWidth:"100%",boxShadow:"0 3px 16px rgba(0,0,0,0.06)"}}/>
          {mode==="view" && <div style={{marginTop:5,fontSize:10,color:"#999"}}>{"Ш/М = ориентация · [ш]="+latL+" · [м]="+lonL+(typo===1?" · [Б]=башня 23.1м":"")}</div>}
        </div>
      </div>
    </div>
  );
}

function STitle(props){return <div style={{fontWeight:700,fontSize:11,marginBottom:5,marginTop:props.mt||0,textTransform:"uppercase",letterSpacing:1,color:"#457b9d"}}>{props.text}</div>}
function Sli(props){return <div style={{marginBottom:5}}><div style={{display:"flex",justifyContent:"space-between",marginBottom:1}}><span style={{fontWeight:600}}>{props.l}</span><span style={{fontWeight:700,color:"#457b9d"}}>{props.v+props.u}</span></div><input type="range" min={props.mn} max={props.mx} step={props.st} value={props.v} onChange={function(e){props.s(+e.target.value)}} style={{width:"100%",height:3,accentColor:"#457b9d"}}/></div>}
function Tog(props){return <div onClick={function(){props.s(!props.v)}} style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,cursor:"pointer",userSelect:"none"}}><div style={{width:26,height:14,borderRadius:7,background:props.v?"#457b9d":"#ccc",position:"relative",transition:"0.2s"}}><div style={{width:10,height:10,borderRadius:5,background:"#fff",position:"absolute",top:2,left:props.v?14:2,transition:"0.2s"}}/></div><span style={{fontSize:11}}>{props.l}</span></div>}
