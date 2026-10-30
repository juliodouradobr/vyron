-- Permissão VIDEO (bit 21, câmera). Servidores existentes herdam a decisão que já tinham para STREAM (bit 16):
-- onde @everyone podia transmitir, passa a poder usar câmera; onde um canal/cargo negava ou liberava
-- transmissão, o mesmo vale para câmera. Depois disso, as duas podem ser ajustadas separadamente.

UPDATE roles SET permissions = permissions | 2097152 WHERE is_default AND (permissions & 65536) <> 0;
UPDATE channel_overwrites SET deny = deny | 2097152 WHERE (deny & 65536) <> 0;
UPDATE channel_overwrites SET allow = allow | 2097152 WHERE (allow & 65536) <> 0;
