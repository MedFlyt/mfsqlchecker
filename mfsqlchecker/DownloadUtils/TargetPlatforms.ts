export type BinaryDownloadPlatform = "darwin" | "linux" | "windows";
export type BinaryDownloadArch = "arm32v7" | "arm64v8" | "amd64" | "ppc64le" | "i386";

export function getCurrentPlatformForDownload(): BinaryDownloadPlatform {
    switch (process.platform) {
        case "cygwin":
        case "win32":
            return "windows";
        case "darwin":
            return "darwin";
        case "linux":
            return "linux";
        default:
            throw new Error(`Unsupported platform: ${process.platform}`);
    }
}


export function getCurrentArchForDownload(): BinaryDownloadArch {
    switch (process.arch) {
        case "arm":
            return "arm32v7";
        case "arm64":
            return "arm64v8";
        case "x64":
            return "amd64";
        case "ppc64":
            return "ppc64le";
        case "ia32":
            return "i386";
        default:
            throw new Error("Unsupported architecture: " + process.arch);
    }
}
