const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const assets = path.join(__dirname,'../assets');
const sizes = [16,24,32,48,64,128,256];

app.whenReady().then(async()=>{
  const source = await fs.readFile(path.join(assets,'icon.svg'));
  const url = 'data:image/svg+xml;base64,'+source.toString('base64');
  const window = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  try {
    await window.loadURL('about:blank');
    const images = await window.webContents.executeJavaScript(`(async()=>{
      const icon=new Image();
      icon.src=${JSON.stringify(url)};
      await icon.decode();
      const canvas=document.createElement('canvas');
      const ctx=canvas.getContext('2d');
      return ${JSON.stringify([...sizes,512])}.map(size=>{
        canvas.width=canvas.height=size;
        ctx.drawImage(icon,0,0,size,size);
        return canvas.toDataURL('image/png').split(',')[1];
      });
    })()`);
    const pngs=images.map(image=>Buffer.from(image,'base64'));
    const directory=Buffer.alloc(6+sizes.length*16);
    directory.writeUInt16LE(1,2);
    directory.writeUInt16LE(sizes.length,4);
    let offset=directory.length;
    sizes.forEach((size,index)=>{
      const entry=6+index*16;
      directory[entry]=directory[entry+1]=size%256;
      directory.writeUInt16LE(1,entry+4);
      directory.writeUInt16LE(32,entry+6);
      directory.writeUInt32LE(pngs[index].length,entry+8);
      directory.writeUInt32LE(offset,entry+12);
      offset+=pngs[index].length;
    });
    await fs.writeFile(path.join(assets,'icon.png'),pngs.pop());
    await fs.writeFile(path.join(assets,'icon.ico'),Buffer.concat([directory,...pngs]));
  } finally {
    window.destroy();
  }
}).then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
