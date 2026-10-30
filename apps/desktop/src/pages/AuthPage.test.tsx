import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthPage } from './AuthPage';
import { ApiError } from '../services/api';
import { api, useSession } from '../stores/session';

beforeEach(() => {
  vi.spyOn(api, 'health').mockResolvedValue({ ok: true });
  useSession.setState({ phase: 'signedOut', signedOutReason: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const fill = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('AuthPage', () => {
  it('valida no cliente antes de chamar o servidor', async () => {
    const login = vi.spyOn(api, 'login');
    render(<AuthPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
    expect(login).not.toHaveBeenCalled();
  });

  it('mostra "conta inexistente" no campo de usuário', async () => {
    vi.spyOn(api, 'login').mockRejectedValue(new ApiError('UNKNOWN_ACCOUNT', 'Não existe conta com esse identificador.', 404));
    render(<AuthPage />);
    fill(/^identificador/i, 'fantasma');
    fill(/^senha$/i, 'qualquer-coisa');
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByText('Não existe conta com esse identificador.')).toBeTruthy();
  });

  it('mostra falha de rede e marca o servidor como inacessível', async () => {
    vi.spyOn(api, 'login').mockRejectedValue(new ApiError('NETWORK', 'Não foi possível conectar ao servidor.'));
    render(<AuthPage />);
    fill(/^identificador/i, 'jogador');
    fill(/^senha$/i, 'senha-forte-1');
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(screen.getByText(/inacessível/)).toBeTruthy());
  });

  it('avisa quando a sessão anterior expirou', () => {
    useSession.setState({ signedOutReason: 'expired' });
    render(<AuthPage />);
    expect(screen.getByText(/sessão expirou/i)).toBeTruthy();
  });

  it('exige confirmação de senha igual no cadastro', async () => {
    const register = vi.spyOn(api, 'register');
    render(<AuthPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Cadastre-se' }));
    fill(/^nome$/i, 'Novo_Jogador');
    fill(/^senha$/i, 'senha-forte-1');
    fill(/confirmar senha/i, 'outra-senha-1');
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }));
    expect(await screen.findByText('As senhas não coincidem.')).toBeTruthy();
    expect(register).not.toHaveBeenCalled();
  });
});
