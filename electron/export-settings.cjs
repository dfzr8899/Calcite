const {getLocale}=require('../shared/i18n/index.mjs');
const paperSizes={A4:[8.27,11.69],A5:[5.83,8.27],B5:[6.93,9.84],Letter:[8.5,11]};
const cssString=text=>'"'+String(text).replace(/[\x00-\x1f<"\\]/g,char=>'\\'+char.charCodeAt(0).toString(16)+' ')+'"';

function printSettings(options) {
  const [width,height]=paperSizes[options.paper]||paperSizes.A4;
  const clamp=(value,fallback)=>Number.isFinite(value)?Math.max(.15,Math.min(2,value)):fallback;
  const y=clamp(options.vertical,.5),x=clamp(options.horizontal,.55);
  const tokens={title:cssString(options.title||''),date:cssString(new Date().toLocaleDateString(getLocale())),
    page:'counter(page)',total:'counter(pages)'};
  const names=['Left','Center','Right'];
  const rows=['header','footer'].flatMap((side,i)=>names.map(position=>{
    const box=(i?'bottom':'top')+'-'+position.toLowerCase();
    let value=options[side+position];
    if(position==='Center'&&!value) value=options[side];
    if(i&&position==='Center'&&options.pageNumbers)value=(value?value+' · ':'')+'{{page}} / {{total}}';
    const content=String(value||'').split(/(\{\{(?:title|date|page|total)\}\})/g).filter(Boolean)
      .map(part=>tokens[part.slice(2,-2)]||cssString(part)).join(' ');
    return {box,content};
  }));
  const boxes=rows.filter(row=>row.content).map(row=>'@'+row.box+'{content:'+row.content+';font:9pt sans-serif;color:#535a68}').join('');
  const first=options.hideFirst?'@page :first{'+rows.map(row=>'@'+row.box+'{content:none}').join('')+'}':'';
  const pageWidth=options.landscape?height:width,pageHeight=options.landscape?width:height;
  const css=`@page{size:${pageWidth}in ${pageHeight}in;margin:${y}in ${x}in;${boxes}}${first}`;
  return {css,print:{printBackground:true,pageSize:{width:pageWidth,height:pageHeight},preferCSSPageSize:true,
    scale:Math.max(.5,Math.min(2,(options.scale||100)/100)),generateDocumentOutline:options.outline!==false,
    margins:{top:y,bottom:y,left:x,right:x}}};
}
module.exports={printSettings};
