// 一笔一笔 StepDraw - 共享导航栏组件
import logo from '../assets/logo.jpg'

import './Navbar.css';
interface NavbarProps {
  title?: string;
  subtitle?: string;
  showBack?: boolean;
  onBack?: () => void;
  rightContent?: React.ReactNode;
}

export function Navbar({
  title = 'StepDraw',
  subtitle = '一笔一笔学画画',
  showBack = false,
  onBack,
  rightContent
}: NavbarProps) {
  return (
    <nav className="navbar">
      <div className="navbar-brand">
        <div className="navbar-icon">
          <img src={logo} className="navbar-icon-logo" />
        </div>
        <div>
          <h1 className="navbar-title">{title}</h1>
          <p className="navbar-subtitle">{subtitle}</p>
        </div>
      </div>
      <div className="navbar-actions">
        {showBack && (
          <button className="navbar-back" onClick={onBack}>
            返回
          </button>
        )}
        {rightContent}
      </div>
    </nav>
  );
}
