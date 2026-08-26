export function debounceFires(events,wait){const out=[];for(let i=0;i<events.length;i++){const [t,id]=events[i];const nxt=events[i+1];if(!nxt||nxt[0]>=t+wait)out.push(id);}return out;}
