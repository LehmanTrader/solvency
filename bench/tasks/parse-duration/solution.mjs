export function parseDuration(s){const m=/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);if(!m||!s||!(m[1]||m[2]||m[3]))return null;return (+(m[1]||0))*3600+(+(m[2]||0))*60+(+(m[3]||0));}
