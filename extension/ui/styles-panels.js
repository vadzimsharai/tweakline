const WG_CSS_PANELS = String.raw`
#over{top:var(--over-cut,0);padding-top:var(--over-top,0)}
#over .dgrab,#over .dgrab *{touch-action:none}
.dlg.sheet .dgrab{height:16px;margin:0}
.dlg.sheet .dhead h2{display:-webkit-box;white-space:normal;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.dlg.sheet .lead{margin:0 0 14px;font-size:14px}
.dlg.sheet .lead.aftbox{margin:14px 0}
.dlg.sheet .lead:last-child{margin-bottom:0}
.dfoot{flex-wrap:wrap}
.dlg.sheet .dfoot .note{flex:0 0 100%;margin:0;font-size:13px}
.btn.big{height:46px;font-size:15px}
.btn.small{position:relative}
.btn.small::after{content:"";position:absolute;inset:-4px 0}

.row.split{padding:0;gap:0}
.rtap{flex:1;min-width:0;display:flex;align-items:center;gap:10px;min-height:56px;padding:8px;border-radius:10px;text-align:left}
.rtap:hover{background:var(--surf)}
.row.split .dicon{margin:0 4px 0 0}
.rgo{display:flex}
.rline{display:flex;align-items:baseline;gap:8px}
.rline .rtitle{flex:1;min-width:0}
.quietline{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;margin-top:12px;padding:0 0 0 2px;border-top:1px solid var(--p-line);color:var(--p-muted);font-size:13px;text-align:left}

.opt .rsub{white-space:normal}
.opt:disabled{opacity:.45;cursor:default;background:none;border-color:var(--p-strong)}
.opt:last-child{margin-bottom:0}
.list.pick{margin-bottom:8px}
.offerservers{margin-bottom:14px}

.sect:has(+.clabel){color:var(--p-fg)}
.nb{white-space:nowrap}
.clabel{margin:12px 0 6px;color:var(--p-muted);font-size:13px}
.sect+.clabel,.sect+.copybox{margin-top:8px}
.copybox+.copybox{margin-top:8px}
.copybox .btn.small{flex:none;background:var(--p-bg)}
.copybox.wrap{align-items:flex-start;padding-block:8px}
.copybox.wrap code,.copybox.wrap .aurl{white-space:normal;overflow:visible;overflow-wrap:anywhere;line-height:1.4;user-select:all;-webkit-user-select:all}
.dbody>.copybox:has(+.wait),.dbody>.copybox:has(+.sect){margin-bottom:0}
.wait{margin-top:18px}

#serverMsg .msg{margin:10px 0 0}
#foundLocal{margin:0 0 14px}
#openWarn{margin:0}

dl.info{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 16px;margin:2px 0 14px;font-size:14px}
dl.info dt{color:var(--p-muted)}
dl.info dd{margin:0;overflow-wrap:anywhere}
dl.info .rdot{display:inline-block;margin:0 7px 1px 0}
#openNote{margin:0 0 14px}

.sess .btn{width:100%;max-width:240px}

.msg code,.lead code{padding:1px 5px;border-radius:5px;background:rgba(255,255,255,.08);color:inherit;font:12.5px var(--mono);white-space:nowrap}
ul.keys .unset{flex:none;color:var(--p-muted);font-size:13px}
.nlist .nrow:first-child{border-top:0}
.field.ncomment{margin:12px 0 0}
.sysline.accend{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:4px 10px}
.rwhen{display:none}
@media(max-width:480px){
.row.split .rmeta{display:none}
.row.split .rwhen{display:inline}
.row.split .rtitle{display:-webkit-box;white-space:normal;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:2}
}
#serverInput{min-height:42px;padding:10px 12px;line-height:20px;overflow:hidden;overflow-wrap:anywhere}
.field+#serverMsg .msg{margin:-4px 0 12px}
`;
