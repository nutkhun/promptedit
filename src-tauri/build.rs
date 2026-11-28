fn main() {
    let target = std::env::var("TARGET").unwrap();
    println!("cargo:rustc-env=TARGET_TRIPLE={target}");
    if target.contains("apple-darwin") {
        link_compiler_rt();
    }
    if target.contains("windows-msvc") {
        delay_load_directml();
    }
    tauri_build::build()
}

/// ONNX Runtime (picture search, `ort` linked statically) is prebuilt with DirectML on Windows, so
/// the app imports DirectML.dll and dxcore.dll, which only newer Windows 10/11 have (and an older
/// DirectML.dll there may lack what ONNX Runtime asks for). PromptEdit only runs ONNX Runtime on the
/// CPU and never starts DirectML, so these are loaded on first use instead of at launch: the app
/// starts on every Windows 10, and they're never loaded at all.
fn delay_load_directml() {
    for dll in ["DirectML.dll", "dxcore.dll"] {
        println!("cargo:rustc-link-arg=/DELAYLOAD:{dll}");
    }
    println!("cargo:rustc-link-lib=delayimp");
}

/// whisper.cpp's Metal code uses Objective-C `@available(...)`, which compiles to calls to
/// `__isPlatformVersionAtLeast` from clang's runtime library. Clang links that library for C and
/// Objective-C programs, but rustc's link line doesn't include it, so the final link fails with
/// "Undefined symbols: ___isPlatformVersionAtLeast". Link it explicitly from the toolchain's
/// clang resource directory.
fn link_compiler_rt() {
    let Ok(out) = std::process::Command::new("xcrun").args(["clang", "--print-resource-dir"]).output() else {
        println!("cargo:warning=couldn't run xcrun clang to find clang's runtime library");
        return;
    };
    let dir = std::path::PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()).join("lib").join("darwin");
    if dir.join("libclang_rt.osx.a").exists() {
        println!("cargo:rustc-link-search=native={}", dir.display());
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    } else {
        println!("cargo:warning=clang runtime library not found in {}", dir.display());
    }
}
