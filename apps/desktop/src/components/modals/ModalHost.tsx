import { useUi } from '../../stores/ui';
import { AddServerModal } from './AddServerModal';
import { ChannelSettingsModal } from './ChannelSettingsModal';
import { CreateChannelModal } from './CreateChannelModal';
import { InviteModal } from './InviteModal';
import { ProfileModal } from './ProfileModal';
import { ServerSettingsModal } from './ServerSettingsModal';

export default function ModalHost() {
  const modal = useUi((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case 'addServer':
      return <AddServerModal />;
    case 'invite':
      return <InviteModal serverId={modal.serverId} />;
    case 'createChannel':
      return <CreateChannelModal serverId={modal.serverId} parentId={modal.parentId} type={modal.type} />;
    case 'channelSettings':
      return <ChannelSettingsModal serverId={modal.serverId} channelId={modal.channelId} />;
    case 'serverSettings':
      return <ServerSettingsModal serverId={modal.serverId} />;
    case 'profile':
      return <ProfileModal key={modal.userId} userId={modal.userId} />;
  }
}
