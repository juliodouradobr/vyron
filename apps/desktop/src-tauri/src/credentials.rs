//! Armazena o token de sessão no Gerenciador de Credenciais do Windows.
//! O token nunca é gravado em arquivo nem no armazenamento do WebView.

use keyring::Entry;

const SERVICE: &str = "app.vyron.desktop";
const ACCOUNT: &str = "session-token";
const MAX_TOKEN_LEN: usize = 128;

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("cofre indisponível: {e}"))
}

#[tauri::command]
pub fn auth_token_get() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("falha ao ler credencial: {e}")),
    }
}

#[tauri::command]
pub fn auth_token_set(token: String) -> Result<(), String> {
    // Validação defensiva: só aceita o formato de token emitido pelo backend.
    if !token.starts_with("nx_") || token.len() > MAX_TOKEN_LEN {
        return Err("token em formato inesperado".into());
    }
    entry()?
        .set_password(&token)
        .map_err(|e| format!("falha ao salvar credencial: {e}"))
}

#[tauri::command]
pub fn auth_token_clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("falha ao remover credencial: {e}")),
    }
}
