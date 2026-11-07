import sharp from 'sharp';
await sharp(process.argv[2]).extract({left:1550,top:750,width:280,height:160}).resize({width:840}).png().toFile(process.argv[3]);
