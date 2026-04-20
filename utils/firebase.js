// utils/firebase.js
import { initializeApp } from "firebase/app";
import {
  initializeAuth,
  getReactNativePersistence,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getFunctions } from "firebase/functions";
import AsyncStorage from "@react-native-async-storage/async-storage";

const firebaseConfig = {
  apiKey: "AIzaSyCZ6QB44EDzqaeOmBdaX8NxUtNITUivY8c",
  authDomain: "roadcash-e05e1.firebaseapp.com",
  projectId: "roadcash-e05e1",
  storageBucket: "roadcash-e05e1.appspot.com",
  messagingSenderId: "68093599355",
  appId: "1:68093599355:web:218602c86a8cc6f43c0cde",
  measurementId: "G-W5KBFD3WKZ",
};

const app = initializeApp(firebaseConfig);

const auth = initializeAuth(app, {
  persistence: getReactNativePersistence(AsyncStorage),
});

const db = getFirestore(app);
const storage = getStorage(app);
const functions = getFunctions(app);

export { auth, db, storage, functions };
