// Synthetic artifact content supplied by the browser test, no user records.
import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArtifactPreview} from '../src/components/ArtifactPreview';
function Fixture(){
 const [html,setHtml]=useState(''),[visible,setVisible]=useState(true),[live,setLive]=useState(false);
 useEffect(()=>{void fetch('/__carbon_dashboard_fixture').then(response=>response.text()).then(setHtml);},[]);
 return <main><button type="button" onClick={()=>setVisible(value=>!value)}>{visible?'Hide dashboard screen':'Show dashboard screen'}</button><button type="button" onClick={()=>setLive(value=>!value)}>Toggle streaming preview</button><div hidden={!visible}><ArtifactPreview html={html} live={live} /></div></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
