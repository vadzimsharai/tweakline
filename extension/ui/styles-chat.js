const WG_CSS_CHAT = String.raw`
#msgs{display:flex;flex-direction:column;padding-bottom:6px}
#msgs>:first-child:not(.sess){margin-top:auto}
#aiLine.off,#editBar.off,#pastBar.off,#chatsBtn.off,.reInp.off,.rehint.off{display:none}

.m{margin:14px 0 0}
.m:first-child{margin-top:0}
.m.cont{margin-top:4px}
.m.cont>div{grid-column:2}
.bub{overflow-wrap:break-word}
.md :not(pre)>code{white-space:nowrap}
.md code.long{white-space:normal;overflow-wrap:anywhere}
.md a{overflow-wrap:anywhere}
.me .bub{cursor:default}
.m.edit-target .bub{border-color:var(--accent)}

.mfiles{display:flex;flex-wrap:wrap;gap:6px}
.mfiles+.mnotes,.mfiles+.mtext,.mfiles+.md{margin-top:8px}
.msgimg{display:block;flex:none;width:132px;max-width:100%;min-height:74px;margin:0;border-radius:8px}
.msgimg:has(img,video){min-height:0}
.msgimg img{max-height:176px;object-fit:cover;object-position:top}
.msgimg video{display:block;width:100%}
.msgimg.gone{display:grid;place-items:center;min-height:44px;padding:0 8px;background:none;color:var(--p-muted);font-size:12px}
.mnotes{display:flex;flex-wrap:wrap;gap:4px}
.mnotes+.mtext{margin-top:6px}
.mnotes .chip{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.mtext{white-space:pre-wrap}
.md pre{white-space:pre-wrap;overflow-wrap:anywhere}

.av::after{background:var(--p-muted)}
#panel.has-session .av::after{background:var(--ok)}

.mstat{display:flex;justify-content:flex-end;gap:8px;color:var(--p-muted);font-size:11px;line-height:16px}
.mstat:empty{display:none}
.mstat:not(:empty){margin-top:3px}
.mst{display:inline-flex;align-items:center;gap:3px}
.mst svg{width:13px;height:13px}
.mst.read svg{color:var(--accent-fg)}
.mtools{display:flex;justify-content:flex-end;gap:6px;margin-top:6px}
.mtools .btn{position:relative}
.mtools .btn::after{content:"";position:absolute;inset:-4px 0}

.sysline{margin:14px 0 0;color:var(--p-muted);font-size:12px;line-height:1.4;text-align:center}
.sysline:first-child{margin-top:0}
.done-line{font:12px/1.4 var(--font)}

.askh{font-weight:600}
.ask .lab{margin:10px 0 5px}
.ask .seg button{min-height:40px}
.ask .inp{margin-top:6px}
.ask .seg button:disabled{opacity:.4;cursor:default}
.rehint{margin-top:5px;color:var(--p-muted);font-size:12px;line-height:1.4}
.askbtns{display:flex;gap:8px;margin-top:12px}
.askbtns .btn{flex:1}
.md:empty+.ask{margin-top:0}

#aiLine{flex:none;display:flex;align-items:center;gap:7px;height:22px;padding-inline:14px;color:var(--p-muted);font-size:12px;line-height:22px;white-space:nowrap}
#panel.full #aiLine{padding-inline:max(14px,calc(50% - 318px))}
#panel.sheet.peek #aiLine{display:none}
.aitext{min-width:0;overflow:hidden;text-overflow:ellipsis}
.aidots{flex:none;display:inline-flex;gap:3px}
.aidots i{width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.35;animation:aiDot 1.2s ease-in-out infinite}
.aidots i:nth-child(2){animation-delay:.2s}
.aidots i:nth-child(3){animation-delay:.4s}
@keyframes aiDot{0%,60%,100%{opacity:.35}30%{opacity:.95}}

#stage.short #aiLine.blank{display:none}
#stage.short .msgimg{width:96px}
#stage.short .msgimg img{max-height:72px}

.acts button{display:inline-flex;align-items:center;gap:5px;max-width:100%;height:auto;min-height:38px;padding-block:6px;border-radius:19px;line-height:1.3;text-align:center}
.acts button.chosen{background:var(--prim);border-color:transparent;color:var(--on-accent)}
.acts button:disabled{cursor:default}
.acts button:disabled:not(.chosen){background:none;border-color:var(--p-line);color:var(--p-muted)}
.actcheck{flex:none;width:14px;height:14px}

#editBar{flex:none;display:flex;align-items:center;justify-content:space-between;height:32px;margin:0 8px 4px;padding-left:10px;border-left:2px solid var(--accent);color:var(--p-fg);font-size:12px}
#editBar .dicon{margin-block:-4px}

#chips{order:-2}
#ta{height:var(--ta-h,32px);overflow-y:hidden}
#ta{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.14) transparent}
#ta.capped{overflow-y:auto;padding-block:0;margin-block:6px}
#ta:placeholder-shown{white-space:nowrap}
#ta::placeholder{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.comp.multi #ta{order:-1;flex:0 0 100%}
.comp.multi .ctl .sp{display:block;order:2;flex:1}
.comp.editing #chips,.comp.editing #plusBtn,.comp.editing #shotBtn{display:none}

#pastBar{flex:none;display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:6px;margin:0 8px 8px;padding:6px 6px 6px 12px;border:1px solid var(--p-strong);border-radius:14px;background:var(--surf);color:var(--p-muted);font-size:13px}
#pastBar>span:first-child{flex:1 1 130px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#pastBar .pastBtns{display:flex;gap:6px}
#pastBar .btn{flex:none;height:40px}
#panel.past .comp,#panel.past #aiLine,#panel.past #editBar{display:none}
#panel.past .acts,#panel.past .ask{pointer-events:none}
.otherChat{min-height:40px;padding:0 10px;color:var(--accent-fg);font-size:12px;text-decoration:underline;text-underline-offset:2px}
.att .attfile{display:flex;align-items:center;max-width:140px;height:48px;padding:0 10px;border:1px solid var(--p-strong);border-radius:8px;background:var(--surf);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msgfile a{display:inline-flex;align-items:center;min-height:36px;padding:0 12px;border:1px solid var(--p-strong);border-radius:8px;color:var(--accent-fg);font-size:13px;text-decoration:none;overflow-wrap:anywhere}
/* Above the width grip, which would take taps meant for the first composer button. */
.comp{z-index:5}
.comp .ib,.comp .send{position:relative;margin-inline:2px}
.comp .ib::after,.comp .send::after{content:"";position:absolute;inset:-3px}
.att .x::before{content:"";position:absolute;inset:-9px}
`;
