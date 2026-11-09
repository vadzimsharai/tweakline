const WG_CSS_SYSTEM = String.raw`
#rail{z-index:8}
#over{padding-inline:var(--over-left,0) var(--over-right,0)}
#over,#over *{touch-action:pan-y}
#over input,#over textarea{touch-action:auto}

.dlg.sheet{display:flex;flex-direction:column;padding:0;overflow:hidden;font:14px/1.45 var(--font)}
.dlg.sheet .dgrab{flex:none}
.dhead{flex:none;display:flex;align-items:center;gap:4px;min-height:48px;padding:6px 6px 6px 16px}
.dhead.hasback{padding-left:6px}
.dlg.sheet .dhead h2{flex:1;min-width:0;margin:0;font-size:17px;font-weight:600;line-height:1.25;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dicon{flex:none;width:40px;height:40px;display:grid;place-items:center;border-radius:10px;color:var(--p-muted)}
.dicon:hover{background:var(--surf);color:var(--p-fg)}
.dbody{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:8px 16px 16px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.14) transparent}
.dfoot{flex:none;display:flex;gap:8px;padding:10px 16px calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--p-line)}
.dfoot .btn{flex:1}
.lead{margin:0 0 14px;color:var(--p-muted);font-size:14px;line-height:1.45;max-width:60ch}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:40px;padding:0 14px;border:1px solid var(--p-strong);border-radius:10px;background:none;color:var(--p-fg);font:500 14px/1 var(--font);white-space:nowrap}
.btn:hover{background:var(--surf)}
.btn.pri{background:var(--prim);border-color:transparent;color:#fff;font-weight:600}
.btn.pri:hover{filter:brightness(1.08)}
.btn.danger{color:var(--danger,#ff7a8f);border-color:color-mix(in srgb,var(--danger,#ff7a8f) 45%,transparent)}
.btn.armed{background:var(--danger,#ff7a8f);border-color:transparent;color:#14060a;font-weight:600}
.btn.full{display:flex;width:100%}
.btn.small{height:32px;padding:0 10px;font-size:13px;border-radius:8px}
.btn:disabled{opacity:.45;cursor:default}

.sect{margin:18px 0 4px;color:var(--p-muted);font-size:13px;font-weight:500}
.sect:first-child{margin-top:4px}
.list{margin:0}
.row{position:relative;display:flex;align-items:center;gap:10px;width:100%;min-height:56px;padding:8px;border-radius:10px;text-align:left}
.row[data-tap]:hover,button.row:hover{background:var(--surf)}
.row.on{background:var(--accent-soft)}
.rdot{flex:none;width:8px;height:8px;margin:0 2px;border-radius:50%;background:#6b7280}
.rdot.ok{background:var(--ok)}
.rdot.warn{background:var(--warn)}
.rmain{flex:1;min-width:0}
.rtitle{display:block;font-size:15px;font-weight:500;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rsub{display:block;margin-top:1px;color:var(--p-muted);font-size:13px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rmeta{flex:none;color:var(--p-muted);font-size:12px}
.rgo{flex:none;color:var(--p-muted)}

.opt{display:flex;align-items:center;gap:12px;width:100%;min-height:68px;padding:12px 10px 12px 14px;margin-bottom:8px;border:1px solid var(--p-strong);border-radius:12px;text-align:left}
.opt:hover{background:var(--surf);border-color:var(--accent)}
.opt svg.oico{flex:none;color:var(--accent-fg)}

.field{display:block;margin-bottom:12px}
.field>span{display:block;margin-bottom:6px;font-size:13px;font-weight:500;color:var(--p-muted)}
.field input{width:100%;height:42px;padding:0 12px;border:1px solid var(--p-strong);border-radius:10px;background:var(--surf);color:var(--p-fg);font:14px var(--font);outline:0}
.field input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}

.copybox{display:flex;align-items:center;gap:8px;min-height:44px;padding:4px 4px 4px 12px;border:1px solid var(--p-strong);border-radius:10px;background:var(--surf)}
.copybox code,.copybox .aurl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:13px var(--font);color:var(--p-fg)}

.msg{margin:10px 0;padding:10px 12px;border-radius:10px;background:var(--surf);font-size:13px;line-height:1.45;color:var(--p-muted)}
.msg.warn{background:var(--warn-bg);color:var(--warn)}
.msg.err{background:color-mix(in srgb,var(--danger,#ff7a8f) 13%,transparent);color:var(--danger,#ff7a8f)}
.field textarea{display:block;width:100%;min-height:60px;padding:9px 12px;border:1px solid var(--p-strong);border-radius:10px;background:var(--surf);color:var(--p-fg);font:14px/1.4 var(--font);outline:0;resize:none}
.field textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.field.pattern{margin:8px 0 0}
#over{padding-top:12px}
#over [hidden]{display:none!important}
#stage{transition:opacity .16s ease}
#stage.shooting{opacity:0}
#stage.shooting #rail,#stage.shooting #panel,#stage.shooting #badge{visibility:visible}
#noteBox{align-items:flex-end}
#noteBox #note{height:auto;min-height:32px;padding:6px 0;line-height:20px;resize:none;overflow-y:auto;white-space:pre-wrap;overflow-wrap:anywhere}
#noteBox .ph2{line-height:32px}
.pdraft{display:flex;align-items:center;gap:10px;max-width:420px;margin:2px 0 14px 32px;padding:10px 10px 10px 14px;border:1px solid var(--p-strong);border-radius:12px;background:var(--surf)}
.pdraft .rsub{white-space:normal}
.pshot{display:block;width:100%;margin:0 0 14px;padding:0;border-radius:10px;overflow:hidden;background:var(--surf)}
.pshot img{display:block;width:100%;max-height:42vh;object-fit:contain}
.dbody>.cmp{height:min(42vh,300px);margin:0 0 14px;border-radius:10px;background:var(--surf)}
.dbody>.cmp img{object-fit:contain;object-position:center}
.dbody>.cmp .mp{background:var(--surf)}
.pscope{margin-top:6px;color:var(--p-muted);font-size:13px;overflow-wrap:anywhere}
.psw{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;margin-top:6px;font-size:14px;font-weight:500}
.psw+.psw{margin-top:0;border-top:1px solid var(--p-line)}
.psw small{display:block;margin-top:1px;color:var(--p-muted);font-size:13px;font-weight:400}
.pcode{margin-top:2px}
.pcode summary{min-height:40px;display:flex;align-items:center;color:var(--accent-fg);font-size:14px;font-weight:500;cursor:pointer}
.pcode pre{margin:0;padding:10px 12px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:10px;background:var(--code-bg);color:var(--code-fg);font:12px/1.5 var(--mono)}
.pc{padding-right:8px}
.popen{flex:1;min-width:0;min-height:44px;text-align:left}
.pc.off .rtitle{color:var(--p-muted)}
.psitetabs{margin-bottom:10px}
.dbody .tocode{margin-top:14px}
.dbody .del{margin-top:8px}
#extSend{color:var(--accent-fg)}
#extSend[hidden]{display:none}
.nsent{margin-top:14px}
.hgroup+.hgroup{border-top:1px solid var(--p-line)}
.hgroup .row{min-height:0;padding-bottom:4px}
.hacts{display:flex;gap:8px;padding:2px 8px 12px}
#stage{--cw:min(calc(100% - 60px),max(360px,min(60%,440px)))}
#sessBtn{flex:0 1 auto;min-width:72px}
#sessBtn b{min-width:0;max-width:none}
@media(max-width:480px){
#panel.full .ph b{display:block}
#panel.full #sessBtn{flex:1 1 0}
#panel.full .ph .sp{display:none}
#panel.full .ph{flex-wrap:wrap;height:auto;padding-top:4px;row-gap:4px}
#stage #panel .ph #rail.inhead{order:9;flex:0 0 calc(100% + 18px);height:40px;margin:0 -6px 0 -12px;padding:0 6px;border-right:0;border-top:1px solid var(--p-line)}
}
@media(min-width:600px){.dlg.wide{margin-inline:calc(12px + var(--over-right,0px)) calc(12px + var(--over-left,0px))}}

.seg{row-gap:8px}
.seg button,#noteBox button{position:relative}
.seg button::after{content:"";position:absolute;inset:-4px 0}
.tog::before{content:"";position:absolute;inset:-8px 0}
.gz::before{content:"";position:absolute;inset:-7px}
#noteBox button{margin-left:4px}
#noteBox button::after{content:"";position:absolute;inset:-3px}
#stage[data-side=right] #badge::before{inset:-12px 0 -12px -22px}
#stage[data-side=left] #badge::before{inset:-12px -22px -12px 0}
.nrow button{width:36px;height:36px}

.psitetabs{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin-top:-4px;padding-block:4px}
.psitetabs button{flex:none;max-width:min(240px,75%);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#pTitle{text-overflow:ellipsis}

#viewer{padding:56px 12px 12px}
`;
