import type { VideoFactoryApi } from '../../preload';

declare global {
  interface Window {
    videoFactory: VideoFactoryApi;
  }
}

export {};
