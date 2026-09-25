// ============================================================
//  НАЛАШТУВАННЯ — заповніть один раз (див. ІНСТРУКЦІЯ.md)
// ============================================================

// 1) Скопіюйте сюди конфігурацію НОВОГО проєкту Firebase (напр. kontrol-znan),
//    а не проєкту «Кабінету курйозів»
//    (Firebase Console → Project settings → General → Your apps → Web app → SDK setup and configuration → Config)
export const firebaseConfig = {
  apiKey: "AIzaSyCfNqgtgPT3Xcjdw_qd3ydt59_2Oea4WCQ",
  authDomain: "kontrol-znan.firebaseapp.com",
  projectId: "kontrol-znan",
  storageBucket: "kontrol-znan.firebasestorage.app",
  messagingSenderId: "21844113335",
  appId: "1:21844113335:web:02112e5815fd3037891a32",
};

// 2) E-mail облікового запису викладача (той самий, що у firestore.rules)
export const TEACHER_EMAIL = "yurchenko09@gmail.com";

// 3) Назва, що показується на сайті
export const SITE_TITLE = "Контроль знань · БЖД, охорона праці та екологія";
