import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...cls: ClassValue[]): string { return twMerge(clsx(cls)); }
