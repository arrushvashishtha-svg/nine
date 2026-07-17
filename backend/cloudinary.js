// Cloudinary setup — handles storage for profile pictures and any
// files (images, video, documents, GIFs) sent in chat.

const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// One-time masked diagnostic so we can confirm what the server actually
// loaded, without printing the real secret. Safe to remove once uploads
// are confirmed working.
function maskedPreview(str){
  if(!str) return '(empty)';
  if(str.length <= 6) return '*'.repeat(str.length);
  return str.slice(0,3) + '*'.repeat(str.length-6) + str.slice(-3) + ` (length ${str.length})`;
}
console.log('[cloudinary-config] cloud_name:', process.env.CLOUDINARY_CLOUD_NAME || '(empty)');
console.log('[cloudinary-config] api_key:', maskedPreview(process.env.CLOUDINARY_API_KEY));
console.log('[cloudinary-config] api_secret:', maskedPreview(process.env.CLOUDINARY_API_SECRET));

function isConfigured() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

// Uploads a buffer (from multer memory storage) to Cloudinary.
// resourceType: 'image' | 'video' | 'raw' (raw = documents/other files)
function uploadBuffer(buffer, { folder, resourceType = 'auto' }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
    stream.end(buffer);
  });
}

module.exports = { cloudinary, uploadBuffer, isConfigured };
