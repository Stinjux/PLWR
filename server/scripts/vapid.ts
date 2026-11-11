import * as webpush from 'web-push';
const k = webpush.generateVAPIDKeys();
console.log('# Ajoute ces lignes à ton fichier .env');
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${k.privateKey}`);
