import type { Timestamp } from 'firebase/firestore';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface UserLink {
  id: string;
  ownerId: string;
  label: string;
  countryCode: string;
  phone: string;
  message: string;
  targetUrl: string;
  shortCode: string;
  shortUrl: string;
  isShortened: boolean;
  active: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface PublicRedirect {
  shortCode: string;
  ownerId: string;
  targetUrl: string;
  active: boolean;
  clickCount: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ClickEvent {
  clickId: string;
  shortCode: string;
  ownerId: string;
  deviceType: 'mobile' | 'desktop' | 'tablet';
  browser: string;
  os: string;
  referrer: string;
  clickedAt: Timestamp;
}

export type MediaPlatform = 'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'direct';

export interface MediaOption {
  id: string;
  label: string;
  format: 'mp4' | 'mp3' | 'jpg' | 'm4a' | 'webm';
  quality: string;
  url: string;
  filename: string;
  sizeBytes?: number;
  noWatermark?: boolean;
  canConvertMp3?: boolean;
}

export interface MediaInspectResult {
  platform: MediaPlatform;
  title: string;
  author: string;
  thumbnail: string;
  durationSec?: number;
  options: MediaOption[];
  warning?: string;
}

export interface YouTubeThumbnailVariant {
  key: string;
  label: string;
  width: number;
  height: number;
  url: string;
  available: boolean;
  sizeBytes: number;
  filename: string;
}

export interface YouTubeThumbnailResult {
  videoId: string;
  title: string;
  author: string;
  thumbnails: YouTubeThumbnailVariant[];
}

export interface DownloadQueueItem {
  id: string;
  title: string;
  platform: MediaPlatform | 'mp3-converter';
  format: string;
  quality: string;
  filename: string;
  status: 'downloading' | 'converting' | 'completed' | 'error' | 'cancelled';
  progressPct: number;
  bytesLoaded: number;
  bytesTotal?: number;
  errorMessage?: string;
  blobUrl?: string;
  createdAt: number;
  sourceUrl?: string;
  abortController?: AbortController;
}
