import Link from 'next/link'

export default function Home() {
  return (
    <div style={{ 
      display: 'flex', 
      flexDirection: 'column', 
      alignItems: 'center', 
      justifyContent: 'center', 
      minHeight: '100vh',
      padding: '2rem',
      textAlign: 'center'
    }}>
      <h1 style={{ fontSize: '3rem', marginBottom: '1rem' }}>Bo</h1>
      <p style={{ fontSize: '1.5rem', marginBottom: '2rem', color: '#666' }}>
        Your Family AI Assistant
      </p>
      
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link 
          href="/portal"
          style={{
            padding: '1rem 2rem',
            background: '#0070f3',
            color: 'white',
            borderRadius: '8px',
            fontSize: '1.1rem',
            fontWeight: '500'
          }}
        >
          Go to Portal
        </Link>
        
        <a
          href="https://t.me/YourBotName"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            padding: '1rem 2rem',
            background: '#0088cc',
            color: 'white',
            borderRadius: '8px',
            fontSize: '1.1rem',
            fontWeight: '500'
          }}
        >
          Open Telegram Bot
        </a>
      </div>

      <div style={{ marginTop: '4rem', color: '#999', fontSize: '0.9rem' }}>
        <p>Multi-tenant AI platform with family groups</p>
        <p>Content moderation • Rate limiting • Privacy-focused</p>
      </div>
    </div>
  )
}
