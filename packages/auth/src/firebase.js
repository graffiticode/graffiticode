import admin from "firebase-admin";

const buildGetApp = () => {
  let app;
  return () => {
    if (!app) {
      app = admin.initializeApp();
    }
    return app;
  };
};

const buildGetAuth = ({ getApp }) => {
  let auth;
  return () => {
    if (!auth) {
      auth = admin.auth(getApp());
    }
    return auth;
  };
};

const buildGetFirestore = ({ getApp }) => {
  let firestore;
  return () => {
    if (!firestore) {
      firestore = admin.firestore(getApp());
    }
    return firestore;
  };
};

const getApp = buildGetApp();
export const getAuth = buildGetAuth({ getApp });
export const getFirestore = buildGetFirestore({ getApp });
