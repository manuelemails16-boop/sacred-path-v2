import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey:            "AIzaSyAsy4EoQ7PTNZK_111U9Andwex7-b468RE",
  authDomain:        "bible-reading-plan-34d45.firebaseapp.com",
  databaseURL:       "https://bible-reading-plan-34d45-default-rtdb.firebaseio.com",
  projectId:         "bible-reading-plan-34d45",
  storageBucket:     "bible-reading-plan-34d45.firebasestorage.app",
  messagingSenderId: "463527603291",
  appId:             "1:463527603291:web:65b45afb4c913db046a37e",
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);