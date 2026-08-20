/**
 * The `cn` helper every shadcn component imports. Standard shadcn output; kept
 * here rather than in `components/ui/` because that directory is eslint-ignored
 * and this file is ours to maintain.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
