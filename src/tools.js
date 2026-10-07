import { z } from 'zod';

const id = z.string().regex(/^[1-9]\d{0,19}$/, '必须是网易云数字 ID');
export const schemas = {
  get_player_state: z.object({}).strict(),
  search_music: z.object({ query: z.string().trim().min(1).max(100), type: z.enum(['song', 'playlist']).default('song'), limit: z.number().int().min(1).max(30).default(10) }).strict(),
  list_my_playlists: z.object({ limit: z.number().int().min(1).max(100).default(30), offset: z.number().int().min(0).default(0) }).strict(),
  play_song: z.object({ id }).strict(),
  play_playlist: z.object({ id, shuffle: z.boolean().default(false) }).strict(),
  get_queue: z.object({ limit: z.number().int().min(1).max(100).default(30), offset: z.number().int().min(0).default(0) }).strict(),
  enqueue: z.object({ ids: z.array(id).min(1).max(50) }).strict(),
  control_player: z.object({ action: z.enum(['pause', 'resume', 'next', 'previous', 'volume']), volume: z.number().min(0).max(100).optional() }).strict().refine(v => v.action !== 'volume' || v.volume !== undefined, 'volume 操作必须提供 0–100 的 volume'),
};
const definitions = [
  ['get_player_state', '读取网易云真实播放状态和连接能力。', {}],
  ['search_music', '搜索真实歌曲或歌单。点歌前先核对歌名、歌手和 ID，不能编造 ID。', {query:{type:'string'},type:{type:'string',enum:['song','playlist']},limit:{type:'integer',minimum:1,maximum:30}}, ['query']],
  ['list_my_playlists', '读取已登录账号创建或收藏的歌单，不修改云端数据。', {limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0}}],
  ['play_song', '立即播放指定网易云歌曲 ID，保留已有待播列表。只有 verified=true 才能宣称成功；超时不要自动重试。', {id:{type:'string',pattern:'^[1-9][0-9]{0,19}$'}}, ['id']],
  ['play_playlist', '用指定歌单替换本地播放队列并开始播放。不会修改云端歌单。', {id:{type:'string',pattern:'^[1-9][0-9]{0,19}$'},shuffle:{type:'boolean'}}, ['id']],
  ['get_queue', '分页读取当前本地待播队列。', {limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0}}],
  ['enqueue', '将歌曲 ID 加入待播队列，不打断当前歌曲。', {ids:{type:'array',minItems:1,maxItems:50,items:{type:'string',pattern:'^[1-9][0-9]{0,19}$'}}}, ['ids']],
  ['control_player', '控制播放。volume 使用 0–100。返回观察到的结果，失败或超时不要盲目重试切歌。', {action:{type:'string',enum:['pause','resume','next','previous','volume']},volume:{type:'number',minimum:0,maximum:100}}, ['action']],
];
export const toolDefinitions = definitions.map(([name,description,properties,required=[]])=>({
  name, description, inputSchema:{type:'object',properties,required,additionalProperties:false},
  annotations:{readOnlyHint:['get_player_state','search_music','list_my_playlists','get_queue'].includes(name), destructiveHint:name==='play_playlist',openWorldHint:true},
}));
export function validateCommand(name,args) {
  if (!Object.hasOwn(schemas,name)) throw new Error('UNKNOWN_TOOL');
  return schemas[name].parse(args ?? {});
}
