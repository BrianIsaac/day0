export interface AgentAvatarPet {
  id: string;
  name: string;
  handle: string;
  src: string;
}

export const SINGAPORE_AI_BUILDER_AVATARS: AgentAvatarPet[] = [
  avatar('tw-agrimsingh', 'agrim singh', '@agrimsingh'),
  avatar('tw-sherryyanjiang', 'Sherry Jiang', '@SherryYanJiang'),
  avatar('tw-unprofeshme', 'rachael', '@unprofeshme'),
  avatar('tw-kasparhidayat', 'Kaspar', '@kasparhidayat'),
  avatar('tw-ivanleomk', 'Ivan Leo', '@ivanleomk'),
  avatar('tw-rachpradhan', 'Rach', '@rachpradhan'),
  avatar('tw-rubanlah', 'ruban', '@rubanlah'),
  avatar('tw-howenyap', 'howen', '@howenyap'),
  avatar('tw-atzydev', 'atzy', '@atzydev'),
  avatar('tw-mxdhavgautam', 'madhav', '@mxdhavgautam'),
  avatar('tw-sentrytoast', 'Akilesh', '@sentrytoast'),
  avatar('tw-jonthe03', 'jon - building', '@jonthe03'),
  avatar('tw-injaneity', 'Zane Chee', '@injaneity'),
  avatar('tw-jiaweihq', 'Jia Wei Ng', '@jiaweihq'),
  avatar('tw-averycode', 'Avery', '@averycode'),
  avatar('tw-kstonekuan', 'kingston kuan', '@kstonekuan'),
  avatar('tw-bytedunks', 'Brandon Ong', '@bytedunks'),
  avatar('tw-ryanlohyr', 'Ryan Loh', '@ryanlohyr'),
  avatar('tw-darenstwt', 'daren', '@darenstwt'),
  avatar('tw-ravernkoh', 'Ravern', '@ravernkoh'),
  avatar('tw-ilhamfputra', 'ilham', '@ilhamfputra'),
  avatar('tw-rwhendry', 'Reynaldo Wijaya Hendry', '@rwhendry'),
  avatar('tw-yjsoon', 'YJ Soon', '@yjsoon'),
  avatar('tw-jensenloke', 'Jensen', '@jensenloke'),
  avatar('tw-hewliyang', 'Li Yang', '@hewliyang'),
  avatar('tw-baggiiiie', 'yingchao', '@baggiiiie'),
  avatar('tw-yongquanyq', 'Yong Quan', '@yongquanYQ'),
  avatar('tw-amodev', 'amo', '@amodev'),
  avatar('tw-danieltskk', 'DanielTsk', '@danieltskk'),
];

export const DEFAULT_AGENT_AVATAR = SINGAPORE_AI_BUILDER_AVATARS[0];

function avatar(id: string, name: string, handle: string): AgentAvatarPet {
  return {
    id,
    name,
    handle,
    src: `/agent-avatars/singapore-ai-builders/${id}.gif`,
  };
}

export function avatarById(id: string | undefined): AgentAvatarPet {
  return SINGAPORE_AI_BUILDER_AVATARS.find((avatar) => avatar.id === id) ?? DEFAULT_AGENT_AVATAR;
}
