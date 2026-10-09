// Service worker de Firebase Cloud Messaging: recibe los avisos de avance de obra con la pestaña cerrada.
// El Worker manda `webpush.notification` + `fcm_options.link`, así que el SDK muestra la notificación
// y al hacer clic abre el visor del proyecto en esa notificación.
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyALlDZKaooZHCGmo_b1dcPVU83ZEO0MSYo",
  authDomain: "lifecity-bim-hub.firebaseapp.com",
  projectId: "lifecity-bim-hub",
  storageBucket: "lifecity-bim-hub.firebasestorage.app",
  messagingSenderId: "1089992266025",
  appId: "1:1089992266025:web:68276ccbdefae6f050e738",
});
firebase.messaging();
