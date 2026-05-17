const Jimp = require('jimp');

async function test() {
  try {
     const imagePng = await Jimp.read('https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png');
     imagePng.greyscale();
     const buffer = await imagePng.getBufferAsync(Jimp.MIME_PNG);
     console.log("Buffer size:", buffer.length);
  } catch (err) {
     console.error(err);
  }
}
test();
