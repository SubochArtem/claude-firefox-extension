import { type CaptureScope, installConsoleCapture } from './console-buffer';

installConsoleCapture(globalThis as unknown as CaptureScope);
