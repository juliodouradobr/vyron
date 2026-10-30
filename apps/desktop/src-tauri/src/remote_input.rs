//! Jogar Juntos — aplicação das entradas remotas no Windows.
//!
//! Regras (todas conferidas AQUI, de novo, independentemente do que a interface já checou):
//! - Nada é aplicado sem `play_arm`, que o frontend só chama depois que o servidor confirmou a
//!   autorização dada pelo anfitrião. `play_disarm` solta tudo e para na hora.
//! - Só os tipos liberados (teclado e/ou mouse).
//! - Só na janela escolhida pelo anfitrião e só enquanto ELA estiver em primeiro plano. Se o
//!   anfitrião trocar de janela, as entradas são ignoradas e tudo que estava pressionado é solto.
//! - Teclas que saem do jogo (Windows, Alt+Tab, Alt+F4, Ctrl+Esc...) são recusadas também aqui.
//! - Usa `SendInput`, a API oficial. Não há elevação de privilégio: pelo UIPI, programas rodando
//!   como administrador não recebem essas entradas — isso é proteção do sistema e é respeitado.
//!   Jogos com anti-cheat podem ignorar entrada simulada; o VYRON não tenta contornar isso.
//! - Atalho global Ctrl+Shift+F12 (registrado em lib.rs) desarma e avisa a interface.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
pub struct PlayState(Mutex<Option<Armed>>);

struct Armed {
    hwnd: isize,
    keyboard: bool,
    mouse: bool,
    held_keys: HashSet<String>,
    held_buttons: HashSet<u8>,
}

#[derive(Serialize)]
pub struct TargetWindow {
    id: i64,
    title: String,
    process: String,
}

/// Mesmo formato do protocolo do frontend (voice/play/input.ts).
#[derive(Deserialize)]
#[serde(tag = "t")]
pub enum InputEvent {
    #[serde(rename = "k")]
    Key { c: String, d: bool },
    #[serde(rename = "m")]
    Move { x: f64, y: f64 },
    #[serde(rename = "b")]
    Button { b: u8, d: bool },
    #[serde(rename = "w")]
    Wheel { dy: i32 },
    #[serde(rename = "r")]
    Release,
}

const BLOCKED_KEYS: &[&str] = &["MetaLeft", "MetaRight", "OSLeft", "OSRight", "ContextMenu", "PrintScreen", "Power", "Sleep", "WakeUp"];

#[tauri::command]
pub fn play_list_windows() -> Vec<TargetWindow> {
    win::list_windows()
}

#[tauri::command]
pub fn play_arm(window_id: i64, keyboard: bool, mouse: bool, state: State<'_, PlayState>) -> Result<(), String> {
    if !keyboard && !mouse {
        return Err("Nenhum tipo de entrada liberado.".into());
    }
    if !win::is_window(window_id as isize) {
        return Err("A janela escolhida não existe mais.".into());
    }
    let mut s = state.0.lock().map_err(|_| "estado indisponível")?;
    if let Some(prev) = s.take() {
        win::release_all(&prev.held_keys, &prev.held_buttons);
    }
    *s = Some(Armed { hwnd: window_id as isize, keyboard, mouse, held_keys: HashSet::new(), held_buttons: HashSet::new() });
    Ok(())
}

#[tauri::command]
pub fn play_disarm(state: State<'_, PlayState>) {
    disarm(&state);
}

pub fn disarm(state: &PlayState) {
    if let Ok(mut s) = state.0.lock() {
        if let Some(prev) = s.take() {
            win::release_all(&prev.held_keys, &prev.held_buttons);
        }
    }
}

#[tauri::command]
pub fn play_input(event: InputEvent, state: State<'_, PlayState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "estado indisponível")?;
    let Some(a) = guard.as_mut() else { return Err("controle remoto não autorizado".into()) };

    // Janela alvo fora de foco: nada vai para outro programa. Solta o que estava pressionado.
    if !win::is_foreground(a.hwnd) {
        if !a.held_keys.is_empty() || !a.held_buttons.is_empty() {
            win::release_all(&a.held_keys, &a.held_buttons);
            a.held_keys.clear();
            a.held_buttons.clear();
        }
        return Err("a janela do jogo não está em primeiro plano".into());
    }

    match event {
        InputEvent::Release => {
            win::release_all(&a.held_keys, &a.held_buttons);
            a.held_keys.clear();
            a.held_buttons.clear();
        }
        InputEvent::Key { c, d } => {
            if !a.keyboard {
                return Err("teclado não autorizado".into());
            }
            if d {
                if BLOCKED_KEYS.contains(&c.as_str()) {
                    return Err("tecla bloqueada".into());
                }
                let alt = a.held_keys.iter().any(|k| k == "AltLeft" || k == "AltRight");
                let ctrl = a.held_keys.iter().any(|k| k == "ControlLeft" || k == "ControlRight");
                if (alt && (c == "Tab" || c == "F4" || c == "Escape")) || (ctrl && c == "Escape") || (ctrl && alt && c == "Delete") {
                    return Err("combinação bloqueada".into());
                }
            }
            let Some(sc) = win::scancode(&c) else { return Err("tecla desconhecida".into()) };
            win::send_key(sc, d);
            if d {
                a.held_keys.insert(c);
            } else {
                a.held_keys.remove(&c);
            }
        }
        InputEvent::Move { x, y } => {
            if !a.mouse {
                return Err("mouse não autorizado".into());
            }
            win::move_in_window(a.hwnd, x.clamp(0.0, 1.0), y.clamp(0.0, 1.0));
        }
        InputEvent::Button { b, d } => {
            if !a.mouse || b > 2 {
                return Err("mouse não autorizado".into());
            }
            win::send_button(b, d);
            if d {
                a.held_buttons.insert(b);
            } else {
                a.held_buttons.remove(&b);
            }
        }
        InputEvent::Wheel { dy } => {
            if !a.mouse {
                return Err("mouse não autorizado".into());
            }
            win::send_wheel(dy.clamp(-10, 10));
        }
    }
    Ok(())
}

#[cfg(windows)]
mod win {
    use super::TargetWindow;
    use std::collections::HashSet;
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, POINT, RECT};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::core::PWSTR;

    pub fn list_windows() -> Vec<TargetWindow> {
        unsafe extern "system" fn cb(hwnd: HWND, lp: LPARAM) -> BOOL {
            let out = &mut *(lp.0 as *mut Vec<TargetWindow>);
            if !IsWindowVisible(hwnd).as_bool() || GetWindow(hwnd, GW_OWNER).map(|o| !o.is_invalid()).unwrap_or(false) {
                return true.into();
            }
            let len = GetWindowTextLengthW(hwnd);
            if len == 0 {
                return true.into();
            }
            let mut buf = vec![0u16; len as usize + 1];
            let n = GetWindowTextW(hwnd, &mut buf);
            let title = String::from_utf16_lossy(&buf[..n as usize]);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            out.push(TargetWindow { id: hwnd.0 as i64, title, process: process_name(pid) });
            true.into()
        }
        let mut out: Vec<TargetWindow> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(cb), LPARAM(&mut out as *mut _ as isize));
        }
        out
    }

    fn process_name(pid: u32) -> String {
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
            let mut buf = [0u16; 260];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size).is_ok();
            let _ = windows::Win32::Foundation::CloseHandle(h);
            if !ok {
                return String::new();
            }
            let path = String::from_utf16_lossy(&buf[..size as usize]);
            path.rsplit('\\').next().unwrap_or("").to_string()
        }
    }

    pub fn is_window(hwnd: isize) -> bool {
        unsafe { IsWindow(HWND(hwnd as _)).as_bool() }
    }

    pub fn is_foreground(hwnd: isize) -> bool {
        unsafe {
            let fg = GetForegroundWindow();
            if fg.0 as isize == hwnd {
                return true;
            }
            // Janelas filhas/donas da mesma janela de jogo contam como a mesma.
            GetAncestor(fg, GA_ROOTOWNER).0 as isize == hwnd
        }
    }

    fn send(inputs: &[INPUT]) {
        unsafe {
            SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    /// Código de varredura (scan code) para KeyboardEvent.code: jogos costumam ler scan codes.
    pub fn scancode(code: &str) -> Option<(u16, bool)> {
        let letters = "QWERTYUIOP";
        let row2 = "ASDFGHJKL";
        let row3 = "ZXCVBNM";
        if let Some(l) = code.strip_prefix("Key") {
            let ch = l.chars().next()?;
            if let Some(i) = letters.find(ch) {
                return Some((0x10 + i as u16, false));
            }
            if let Some(i) = row2.find(ch) {
                return Some((0x1E + i as u16, false));
            }
            if let Some(i) = row3.find(ch) {
                return Some((0x2C + i as u16, false));
            }
            return None;
        }
        if let Some(d) = code.strip_prefix("Digit") {
            let n: u16 = d.parse().ok()?;
            return Some((if n == 0 { 0x0B } else { 0x01 + n }, false));
        }
        if let Some(f) = code.strip_prefix('F') {
            if let Ok(n) = f.parse::<u16>() {
                return match n {
                    1..=10 => Some((0x3A + n, false)),
                    11 => Some((0x57, false)),
                    12 => Some((0x58, false)),
                    _ => None,
                };
            }
        }
        Some(match code {
            "Escape" => (0x01, false),
            "Minus" => (0x0C, false),
            "Equal" => (0x0D, false),
            "Backspace" => (0x0E, false),
            "Tab" => (0x0F, false),
            "BracketLeft" => (0x1A, false),
            "BracketRight" => (0x1B, false),
            "Enter" => (0x1C, false),
            "ControlLeft" => (0x1D, false),
            "Semicolon" => (0x27, false),
            "Quote" => (0x28, false),
            "Backquote" => (0x29, false),
            "ShiftLeft" => (0x2A, false),
            "Backslash" => (0x2B, false),
            "Comma" => (0x33, false),
            "Period" => (0x34, false),
            "Slash" => (0x35, false),
            "IntlRo" => (0x73, false),
            "ShiftRight" => (0x36, false),
            "AltLeft" => (0x38, false),
            "Space" => (0x39, false),
            "CapsLock" => (0x3A, false),
            "ControlRight" => (0x1D, true),
            "AltRight" => (0x38, true),
            "Insert" => (0x52, true),
            "Delete" => (0x53, true),
            "Home" => (0x47, true),
            "End" => (0x4F, true),
            "PageUp" => (0x49, true),
            "PageDown" => (0x51, true),
            "ArrowUp" => (0x48, true),
            "ArrowDown" => (0x50, true),
            "ArrowLeft" => (0x4B, true),
            "ArrowRight" => (0x4D, true),
            "NumpadEnter" => (0x1C, true),
            "Numpad0" => (0x52, false),
            "Numpad1" => (0x4F, false),
            "Numpad2" => (0x50, false),
            "Numpad3" => (0x51, false),
            "Numpad4" => (0x4B, false),
            "Numpad5" => (0x4C, false),
            "Numpad6" => (0x4D, false),
            "Numpad7" => (0x47, false),
            "Numpad8" => (0x48, false),
            "Numpad9" => (0x49, false),
            "NumpadAdd" => (0x4E, false),
            "NumpadSubtract" => (0x4A, false),
            "NumpadMultiply" => (0x37, false),
            "NumpadDivide" => (0x35, true),
            "NumpadDecimal" => (0x53, false),
            _ => return None,
        })
    }

    pub fn send_key((sc, ext): (u16, bool), down: bool) {
        let mut flags = KEYEVENTF_SCANCODE;
        if ext {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        if !down {
            flags |= KEYEVENTF_KEYUP;
        }
        send(&[INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: sc, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        }]);
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) {
        send(&[INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        }]);
    }

    /// Posição normalizada (0–1) da imagem → ponto dentro da área cliente da janela alvo.
    pub fn move_in_window(hwnd: isize, x: f64, y: f64) {
        unsafe {
            let h = HWND(hwnd as _);
            let mut rc = RECT::default();
            if GetClientRect(h, &mut rc).is_err() {
                return;
            }
            let mut pt = POINT { x: rc.left + ((rc.right - rc.left) as f64 * x) as i32, y: rc.top + ((rc.bottom - rc.top) as f64 * y) as i32 };
            if !ClientToScreen(h, &mut pt).as_bool() {
                return;
            }
            let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1);
            let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1);
            let ax = ((pt.x - vx) as f64 * 65535.0 / vw as f64) as i32;
            let ay = ((pt.y - vy) as f64 * 65535.0 / vh as f64) as i32;
            mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay, 0);
        }
    }

    pub fn send_button(b: u8, down: bool) {
        let f = match (b, down) {
            (0, true) => MOUSEEVENTF_LEFTDOWN,
            (0, false) => MOUSEEVENTF_LEFTUP,
            (1, true) => MOUSEEVENTF_MIDDLEDOWN,
            (1, false) => MOUSEEVENTF_MIDDLEUP,
            (2, true) => MOUSEEVENTF_RIGHTDOWN,
            _ => MOUSEEVENTF_RIGHTUP,
        };
        mouse(f, 0, 0, 0);
    }

    pub fn send_wheel(lines: i32) {
        // Rolagem para baixo no navegador (dy > 0) = WHEEL_DELTA negativo no Windows.
        mouse(MOUSEEVENTF_WHEEL, 0, 0, -lines * WHEEL_DELTA as i32);
    }

    pub fn release_all(keys: &HashSet<String>, buttons: &HashSet<u8>) {
        for k in keys {
            if let Some(sc) = scancode(k) {
                send_key(sc, false);
            }
        }
        for b in buttons {
            send_button(*b, false);
        }
    }
}

/// Fora do Windows o recurso não existe: tudo recusa, nada é aplicado.
#[cfg(not(windows))]
mod win {
    use super::TargetWindow;
    use std::collections::HashSet;
    pub fn list_windows() -> Vec<TargetWindow> {
        Vec::new()
    }
    pub fn is_window(_: isize) -> bool {
        false
    }
    pub fn is_foreground(_: isize) -> bool {
        false
    }
    pub fn scancode(_: &str) -> Option<(u16, bool)> {
        None
    }
    pub fn send_key(_: (u16, bool), _: bool) {}
    pub fn move_in_window(_: isize, _: f64, _: f64) {}
    pub fn send_button(_: u8, _: bool) {}
    pub fn send_wheel(_: i32) {}
    pub fn release_all(_: &HashSet<String>, _: &HashSet<u8>) {}
}
