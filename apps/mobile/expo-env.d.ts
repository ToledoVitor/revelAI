/// <reference types="expo/types" />

declare namespace NodeJS {
  interface ProcessEnv {
    EXPO_PUBLIC_API_URL?: string;
  }
}

declare module "*.png" {
  const asset: number;
  export default asset;
}
