async function testGeminiKey() {
  const geminiKey = 'REDACTED_GEMINI_KEY';
  
  console.log('Testing Gemini API Key by listing models...');
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`);
    
    console.log('Gemini HTTP Status:', res.status);
    const data = await res.json();
    
    if (res.ok) {
        console.log('✅ Gemini Success! Models available:', data.models.map(m => m.name).join(', '));
    } else {
        console.log('❌ Gemini Failed:', data.error?.message || data);
    }
  } catch(e) {
    console.log('Gemini Error:', e.message);
  }
}
testGeminiKey();
