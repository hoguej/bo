export default function PortalPage() {
  return (
    <div style={{ 
      maxWidth: '1200px', 
      margin: '0 auto', 
      padding: '2rem'
    }}>
      <header style={{ 
        borderBottom: '2px solid #eee', 
        paddingBottom: '1rem', 
        marginBottom: '2rem' 
      }}>
        <h1>Bo Portal</h1>
        <p style={{ color: '#666', marginTop: '0.5rem' }}>
          Manage your family, todos, and settings
        </p>
      </header>

      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', 
        gap: '1.5rem' 
      }}>
        <div style={{ 
          background: 'white', 
          padding: '1.5rem', 
          borderRadius: '8px', 
          boxShadow: '0 2px 4px rgba(0,0,0,0.1)' 
        }}>
          <h2 style={{ marginBottom: '1rem' }}>Family Members</h2>
          <p style={{ color: '#666' }}>
            View and manage your family members
          </p>
          <button style={{
            marginTop: '1rem',
            padding: '0.5rem 1rem',
            background: '#0070f3',
            color: 'white',
            border: 'none',
            borderRadius: '4px'
          }}>
            Manage Members
          </button>
        </div>

        <div style={{ 
          background: 'white', 
          padding: '1.5rem', 
          borderRadius: '8px', 
          boxShadow: '0 2px 4px rgba(0,0,0,0.1)' 
        }}>
          <h2 style={{ marginBottom: '1rem' }}>Todos</h2>
          <p style={{ color: '#666' }}>
            Manage family todos and reminders
          </p>
          <button style={{
            marginTop: '1rem',
            padding: '0.5rem 1rem',
            background: '#0070f3',
            color: 'white',
            border: 'none',
            borderRadius: '4px'
          }}>
            View Todos
          </button>
        </div>

        <div style={{ 
          background: 'white', 
          padding: '1.5rem', 
          borderRadius: '8px', 
          boxShadow: '0 2px 4px rgba(0,0,0,0.1)' 
        }}>
          <h2 style={{ marginBottom: '1rem' }}>Settings</h2>
          <p style={{ color: '#666' }}>
            Configure AI personality and preferences
          </p>
          <button style={{
            marginTop: '1rem',
            padding: '0.5rem 1rem',
            background: '#0070f3',
            color: 'white',
            border: 'none',
            borderRadius: '4px'
          }}>
            Go to Settings
          </button>
        </div>
      </div>

      <div style={{ 
        marginTop: '2rem', 
        padding: '1.5rem', 
        background: '#f9f9f9', 
        borderRadius: '8px',
        border: '1px solid #eee'
      }}>
        <h3 style={{ marginBottom: '0.5rem' }}>Quick Stats</h3>
        <div style={{ display: 'flex', gap: '2rem', marginTop: '1rem' }}>
          <div>
            <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#0070f3' }}>12</div>
            <div style={{ color: '#666', fontSize: '0.9rem' }}>Active Todos</div>
          </div>
          <div>
            <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#0070f3' }}>4</div>
            <div style={{ color: '#666', fontSize: '0.9rem' }}>Family Members</div>
          </div>
          <div>
            <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#0070f3' }}>156</div>
            <div style={{ color: '#666', fontSize: '0.9rem' }}>Conversations</div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: '2rem', textAlign: 'center', color: '#999', fontSize: '0.9rem' }}>
        <p>✨ Powered by Bo • Multi-tenant AI Platform</p>
      </div>
    </div>
  )
}
