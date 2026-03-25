import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function shortSessionId(sessionId: string) {
  return sessionId.replace("session_", "").slice(0, 8)
}

